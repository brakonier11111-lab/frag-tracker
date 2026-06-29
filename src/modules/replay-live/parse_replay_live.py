#!/usr/bin/env python3
"""Parse data.replay + optional battle_results for live damage JSON (stdout)."""
import io
import json
import pickle
import re
import struct
import sys
import zipfile

REPLAY_MAGIC = 0x12345678


def read_varint(data, i):
    val = 0
    shift = 0
    while i < len(data):
        b = data[i]
        i += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, i
        shift += 7
    return None, i


def parse_subtype55_players(payload):
    players = {}
    i = 12
    while i < len(payload) - 10:
        if payload[i] != 0x08:
            i += 1
            continue
        entity_id, j = read_varint(payload, i + 1)
        if entity_id is None or entity_id < 1000:
            i += 1
            continue
        rest = payload[j:j + 80]
        if len(rest) < 20 or rest[0] != 0x12 or rest[1] != 0x0F:
            i += 1
            continue
        k = 17
        if rest[k] != 0x1A:
            i += 1
            continue
        nick_len = rest[k + 1]
        if nick_len < 2 or nick_len > 24 or k + 2 + nick_len > len(rest):
            i += 1
            continue
        nick = rest[k + 2:k + 2 + nick_len].decode('utf8', 'ignore')
        if not re.match(r'^[A-Za-z0-9_\-]{2,24}$', nick):
            i += 1
            continue
        team = 0
        account_id = 0
        tail = rest[k + 2 + nick_len:k + 2 + nick_len + 20]
        t = 0
        while t < len(tail) - 1:
            tag = tail[t]
            t += 1
            field = tag >> 3
            wire = tag & 7
            if wire == 0:
                val, t = read_varint(tail, t)
                if val is None:
                    break
                if field == 4 and val in (1, 2):
                    team = val
                if field == 7:
                    account_id = val
            elif wire == 2:
                ln, t = read_varint(tail, t)
                if ln is None:
                    break
                t += ln
            elif wire == 5:
                t += 4
            elif wire == 1:
                t += 8
            else:
                break
        players[entity_id] = {
            'entityId': entity_id,
            'nickname': nick,
            'team': team,
            'accountId': account_id,
        }
        i = j + 17
    return players


def parse_live_damage(data, tail_reserve=256):
    damage = {}
    safe = max(0, len(data) - tail_reserve)
    if safe < 16 or struct.unpack_from('<I', data, 0)[0] != REPLAY_MAGIC:
        return damage

    offset = 4 + 8
    hash_len = data[offset]
    offset += 1 + hash_len
    version_len = data[offset]
    offset += 1 + version_len + 1

    while offset + 12 <= safe:
        payload_len = struct.unpack_from('<I', data, offset)[0]
        offset += 4
        pkt_type = struct.unpack_from('<I', data, offset)[0]
        offset += 4
        offset += 4
        if payload_len > safe - offset or payload_len > 5_000_000:
            break
        payload = data[offset:offset + payload_len]
        offset += payload_len

        if pkt_type != 7 or payload_len != 14:
            continue
        if struct.unpack_from('<I', payload, 8)[0] != 2:
            continue
        if struct.unpack_from('<I', payload, 4)[0] != 4:
            continue
        entity_id = struct.unpack_from('<I', payload, 0)[0]
        value = struct.unpack_from('<H', payload, 12)[0]
        if 0 < value < 2500:
            damage[entity_id] = max(damage.get(entity_id, 0), value)

    return damage


def parse_roster_from_battle_results(pb):
    roster = {}
    skip = {
        'lumber', 'holland', 'faust', 'lagoon', 'port', 'canyon', 'idle', 'desert_train',
        'milbase', 'malinovka', 'mountain', 'erlenberg', 'karelia', 'savanna', 'fort',
        'pliego', 'rift', 'medvedkovo', 'rock', 'forgecity', 'neptune', 'himmelsdorf',
        'plant', 'training', 'booster', 'italy', 'rudniki', 'grossberg', 'mars', 'skit',
        'canal', 'amigosville', 'glacier', 'mars_br', 'avatar_wins', 'None', 'ZOMBI', 'XEH_K2',
    }
    i = 0
    while i < len(pb) - 5:
        if pb[i] != 0x0A:
            i += 1
            continue
        nick_len, j = read_varint(pb, i + 1)
        if nick_len is None or nick_len < 2 or nick_len > 24 or j + nick_len > len(pb):
            i += 1
            continue
        nick = pb[j:j + nick_len].decode('utf8', 'ignore')
        if not re.match(r'^[A-Za-z0-9_\-]{2,24}$', nick) or nick in skip:
            i += 1
            continue
        team = 0
        account_id = 0
        k = j + nick_len
        end = min(len(pb), k + 40)
        while k < end - 1:
            tag = pb[k]
            k += 1
            field = tag >> 3
            wire = tag & 7
            if wire == 0:
                val, k = read_varint(pb, k)
                if val is None:
                    break
                if field == 4 and val in (1, 2):
                    team = val
                if field == 7:
                    account_id = val
            elif wire == 2:
                ln, k = read_varint(pb, k)
                if ln is None:
                    break
                k += ln
            elif wire == 5:
                k += 4
            elif wire == 1:
                k += 8
            else:
                break
        roster[nick.lower()] = {
            'nickname': nick,
            'team': team,
            'accountId': account_id,
        }
        i += 1
    return roster


def parse_final_damage_by_entity(pb):
    final = {}
    i = 0
    while i < len(pb) - 5:
        if pb[i] != 0x40:
            i += 1
            continue
        dmg, j = read_varint(pb, i + 1)
        if dmg is None or not (500 < dmg < 5000):
            i += 1
            continue
        back = pb[max(0, i - 30):i]
        entity_id = None
        for k in range(len(back) - 2):
            if back[k] != 0x08:
                continue
            ent, _ = read_varint(back, k + 1)
            if ent and 10_000_000 <= ent <= 500_000_000:
                entity_id = ent
                break
        if entity_id is not None:
            final[entity_id] = max(final.get(entity_id, 0), dmg)
        i = j
    return final


def load_battle_results_bytes(path, from_zip=False):
    if from_zip:
        with zipfile.ZipFile(path) as zf:
            raw = zf.read('battle_results.dat')
    else:
        with open(path, 'rb') as fh:
            raw = fh.read()
    try:
        obj = pickle.loads(raw, encoding='bytes')
    except TypeError:
        obj = pickle.loads(raw)
    if isinstance(obj, tuple) and len(obj) > 1:
        pb = obj[1]
        return pb if isinstance(pb, (bytes, bytearray)) else bytes(pb)
    return raw


def merge_players(entity_players, live_damage, final_damage, roster):
    merged = {}
    for entity_id, info in entity_players.items():
        row = dict(info)
        row['damageDealt'] = live_damage.get(entity_id)
        row['damageSource'] = 'live' if row['damageDealt'] else None
        merged[entity_id] = row

    for entity_id, dmg in final_damage.items():
        row = merged.get(entity_id, {
            'entityId': entity_id,
            'nickname': '',
            'team': 0,
            'accountId': 0,
        })
        row['damageDealt'] = dmg
        row['damageSource'] = 'battle_results'
        merged[entity_id] = row

    for row in merged.values():
        nick = row.get('nickname') or ''
        meta = roster.get(nick.lower())
        if meta:
            if not row.get('team'):
                row['team'] = meta.get('team') or 0
            if not row.get('accountId'):
                row['accountId'] = meta.get('accountId') or 0
            if not row.get('nickname'):
                row['nickname'] = meta.get('nickname') or nick

    players = list(merged.values())
    players.sort(key=lambda p: (-(p.get('damageDealt') or 0), p.get('nickname') or ''))
    return players


def parse_data_replay(data):
    result = {
        'clientVersion': '',
        'battleTimeSec': 0,
        'authorNickname': '',
        'arenaUniqueId': None,
        'battleLevel': None,
        'packetCount': 0,
        'players': [],
    }
    safe = max(0, len(data) - 256)
    if safe < 16 or struct.unpack_from('<I', data, 0)[0] != REPLAY_MAGIC:
        return result

    offset = 4 + 8
    hash_len = data[offset]
    offset += 1 + hash_len
    version_len = data[offset]
    offset += 1 + version_len
    result['clientVersion'] = data[offset:offset + version_len].decode('utf8', 'ignore')
    offset += version_len + 1

    entity_players = {}
    live_damage = parse_live_damage(data)

    while offset + 12 <= safe:
        payload_len = struct.unpack_from('<I', data, offset)[0]
        offset += 4
        pkt_type = struct.unpack_from('<I', data, offset)[0]
        offset += 4
        clock = struct.unpack_from('<f', data, offset)[0]
        offset += 4
        if payload_len > safe - offset or payload_len > 5_000_000:
            break
        payload = data[offset:offset + payload_len]
        offset += payload_len

        result['packetCount'] += 1
        result['battleTimeSec'] = max(result['battleTimeSec'], clock)

        if pkt_type == 0 and len(payload) > 20:
            nick_len = payload[10]
            if nick_len and 10 + 1 + nick_len <= len(payload):
                result['authorNickname'] = payload[11:11 + nick_len].decode('utf8', 'ignore')
            if len(payload) >= 22:
                result['arenaUniqueId'] = struct.unpack_from('<Q', payload, 11 + nick_len + 1)[0]

        if pkt_type == 8 and payload_len > 500 and struct.unpack_from('<I', payload, 4)[0] == 55:
            entity_players.update(parse_subtype55_players(payload))

    result['players'] = merge_players(entity_players, live_damage, {}, {})
    return result


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'success': False, 'error': 'no_path'}))
        return 1

    replay_path = sys.argv[1]
    battle_results_path = sys.argv[2] if len(sys.argv) > 2 else ''

    try:
        if replay_path.lower().endswith('.tbreplay') and zipfile.is_zipfile(replay_path):
            with zipfile.ZipFile(replay_path) as zf:
                data = zf.read('data.replay')
        else:
            with open(replay_path, 'rb') as fh:
                data = fh.read()
    except Exception as exc:
        print(json.dumps({'success': False, 'error': str(exc)}))
        return 1

    parsed = parse_data_replay(data)
    final_damage = {}
    roster = {}

    if battle_results_path:
        try:
            from_zip = battle_results_path.lower().endswith('.tbreplay')
            pb = load_battle_results_bytes(battle_results_path, from_zip=from_zip)
            final_damage = parse_final_damage_by_entity(pb)
            roster = parse_roster_from_battle_results(pb)
        except Exception:
            pass

    entity_players = {p['entityId']: p for p in parsed['players'] if p.get('entityId')}
    for entity_id, info in entity_players.items():
        if not info.get('nickname'):
            continue
    # rebuild from subtype55 directly
    entity_players = {}
    safe = max(0, len(data) - 256)
    offset = 4 + 8
    hash_len = data[offset]
    offset += 1 + hash_len
    version_len = data[offset]
    offset += 1 + version_len + 1
    while offset + 12 <= safe:
        payload_len = struct.unpack_from('<I', data, offset)[0]
        offset += 4
        pkt_type = struct.unpack_from('<I', data, offset)[0]
        offset += 4
        offset += 4
        if payload_len > safe - offset:
            break
        payload = data[offset:offset + payload_len]
        offset += payload_len
        if pkt_type == 8 and payload_len > 500 and struct.unpack_from('<I', payload, 4)[0] == 55:
            entity_players.update(parse_subtype55_players(payload))

    live_damage = parse_live_damage(data)
    players = merge_players(entity_players, live_damage, final_damage, roster)

    print(json.dumps({
        'success': True,
        'clientVersion': parsed['clientVersion'],
        'battleTimeSec': parsed['battleTimeSec'],
        'authorNickname': parsed['authorNickname'],
        'arenaUniqueId': parsed['arenaUniqueId'],
        'packetCount': parsed['packetCount'],
        'players': players,
        'liveDamageCount': len(live_damage),
        'finalDamageCount': len(final_damage),
    }))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
