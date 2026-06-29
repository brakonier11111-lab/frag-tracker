#!/usr/bin/env python3
"""Extract author battle stats from .tbreplay / .wotbreplay (stdout JSON)."""
import json
import pickle
import sys
import zipfile


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


def parse_roster(pb):
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
        import re
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


def parse_combat_submessage(buf):
    fields = {}
    i = 0
    while i < len(buf) - 1:
        tag = buf[i]
        i += 1
        field = tag >> 3
        wire = tag & 7
        if wire == 0:
            val, i = read_varint(buf, i)
            if val is None:
                break
            fields[field] = val
        elif wire == 2:
            ln, i = read_varint(buf, i)
            if ln is None:
                break
            i += ln
        elif wire == 5:
            i += 4
        elif wire == 1:
            i += 8
        else:
            break
    damage = fields.get(8, 0)
    if damage <= 100:
        return None
    return {
        'shotsFired': fields.get(4, 0),
        'hits': fields.get(5, 0),
        'penetrations': fields.get(7, 0),
        'damageDealt': damage,
        'hitsReceived': fields.get(12, 0),
        'penetrationsReceived': fields.get(15, 0),
        'frags': fields.get(6) or fields.get(18, 0),
    }


def parse_combat_stats_by_entity(pb):
    stats = {}
    i = 0
    while i < len(pb) - 12:
        if pb[i] != 0x08:
            i += 1
            continue
        entity_id, j = read_varint(pb, i + 1)
        if entity_id is None or not (10_000_000 <= entity_id <= 500_000_000):
            i += 1
            continue
        window = pb[j:j + 220]
        k = 0
        while k < len(window) - 3:
            if window[k] != 0x12:
                k += 1
                continue
            ln, sub_start = read_varint(window, k + 1)
            if ln is None or ln < 15 or ln > 256:
                k += 1
                continue
            sub_end = sub_start + ln
            if sub_end > len(window):
                k += 1
                continue
            combat = parse_combat_submessage(window[sub_start:sub_end])
            if combat:
                stats[entity_id] = combat
                break
            k += 1
        i = j
    return stats


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


def find_author_fields(pb):
    best_damage = None
    best_xp = None
    best_frags = None

    def walk(message, depth=0):
        nonlocal best_damage, best_xp, best_frags
        if depth > 8:
            return
        i = 0
        while i < len(message) - 1:
            tag = message[i]
            i += 1
            field = tag >> 3
            wire = tag & 7
            if wire == 0:
                val, i = read_varint(message, i)
                if val is None:
                    break
                if field == 8 and 100 < val < 25000:
                    best_damage = val if best_damage is None else max(best_damage, val)
                elif field == 3 and 50 < val < 15000:
                    best_xp = val if best_xp is None else max(best_xp, val)
                elif field in (6, 18) and 0 <= val < 20:
                    best_frags = val if best_frags is None else max(best_frags, val)
            elif wire == 2:
                ln, i = read_varint(message, i)
                if ln is None or i + ln > len(message):
                    break
                walk(message[i:i + ln], depth + 1)
                i += ln
            elif wire == 5:
                i += 4
            elif wire == 1:
                i += 8
            else:
                break

    walk(pb)
    if best_damage is None:
        for i in range(min(len(pb) - 2, 6000)):
            if pb[i] != 0x40:
                continue
            val, _ = read_varint(pb, i + 1)
            if val and 100 < val < 25000:
                best_damage = val if best_damage is None else max(best_damage, val)
    return {
        'damageDealt': best_damage,
        'baseXp': best_xp,
        'frags': best_frags,
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'success': False, 'error': 'no_path'}))
        return 1
    path = sys.argv[1]
    try:
        with zipfile.ZipFile(path) as zf:
            meta = json.loads(zf.read('meta.json'))
            raw = zf.read('battle_results.dat')
    except Exception as exc:
        print(json.dumps({'success': False, 'error': str(exc)}))
        return 1

    try:
        try:
            obj = pickle.loads(raw, encoding='bytes')
        except TypeError:
            obj = pickle.loads(raw)
        pb = obj[1] if isinstance(obj, tuple) and len(obj) > 1 else raw
        if not isinstance(pb, (bytes, bytearray)):
            pb = bytes(pb)
    except Exception:
        pb = raw

    author = find_author_fields(pb)
    roster = parse_roster(pb)
    combat_stats = parse_combat_stats_by_entity(pb)
    final_damage = parse_final_damage_by_entity(pb)
    for entity_id, combat in combat_stats.items():
        if combat.get('damageDealt'):
            final_damage[entity_id] = combat['damageDealt']
    players = []
    for entity_id, damage in sorted(final_damage.items(), key=lambda x: -x[1]):
        row = {
            'entityId': entity_id,
            'nickname': '',
            'team': 0,
            'accountId': 0,
            'damageDealt': damage,
            'damageSource': 'battle_results',
        }
        combat = combat_stats.get(entity_id)
        if combat:
            row.update(combat)
        players.append(row)

    player_name = (meta.get('playerName') or '').lower()
    if player_name:
        author_match = next((p for p in players if p['damageDealt'] is not None), None)
        for p in players:
            roster_row = roster.get(player_name)
            if roster_row and author_match and p is author_match:
                author['damageDealt'] = p['damageDealt']
                break
        # Prefer exact author row when Node merges nicknames; fallback keeps protobuf scan
        for entity_id, damage in final_damage.items():
            if damage == author.get('damageDealt'):
                break

    print(json.dumps({
        'success': True,
        'meta': meta,
        'author': author,
        'players': players,
        'roster': list(roster.values()),
    }))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
