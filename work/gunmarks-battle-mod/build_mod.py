#!/usr/bin/env python3
"""Сборка mod-pack: отметки в ангаре + безопасная панель в бою."""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

try:
    import lz4.block
except ImportError as exc:
    raise SystemExit('pip install lz4') from exc

ROOT = Path(__file__).resolve().parent
GAME = Path(r'E:\Games\Tanks_Blitz')
MOD_HANGAR = Path(r'c:\Users\ixacy\Downloads\Data\decoded\Hangar.yaml')
VANILLA_HUD = ROOT.parent / 'blitz-ui-decode' / 'UI' / 'Screens' / 'Battle' / 'HUDLayer.yaml'
PANEL = ROOT / 'battle_gunmarks_panel.yaml'
OUT_DATA = ROOT / 'Data'

SESSION_PARAM = '            - ["SessionDataModel", "session", "null", "{ }"]\n'
TANK_BINDING = '            - ["OwnedTank", "playerTank", "session.playerTanks.currentTank"]\n'
OLD_DOSSIER_BINDING = (
    '            - ["VehicleDossier", "playerDossier", '
    '"when not isNull(session) and not isNull(session.playerTanks.currentTank) '
    '-> session.playerTanks.currentTank.dossier, null"]\n'
)


def encode_dvpl(raw: bytes, compression: int = 1) -> bytes:
    payload = raw if compression == 0 else lz4.block.compress(raw, store_size=False)
    crc = zlib.crc32(payload) & 0xFFFFFFFF
    footer = struct.pack('<IIII', len(raw), len(payload), crc, compression)
    footer += struct.pack('>I', 0x4456504C)
    return payload + footer


def decode_dvpl_bytes(data: bytes) -> bytes:
    orig_size, _, _, comp_type = struct.unpack('<IIII', data[-20:-4])
    payload = data[:-20]
    if comp_type == 0:
        return payload[:orig_size]
    if comp_type in (1, 2):
        return lz4.block.decompress(payload, uncompressed_size=orig_size)
    raise ValueError(f'unsupported compression type {comp_type}')


def decode_dvpl(path: Path) -> bytes:
    return decode_dvpl_bytes(path.read_bytes())


def load_vanilla_hud() -> str:
    if VANILLA_HUD.is_file():
        return VANILLA_HUD.read_text(encoding='utf-8')
    src = GAME / 'Data' / 'UI' / 'Screens' / 'Battle' / 'HUDLayer.yaml.dvpl'
    return decode_dvpl(src).decode('utf-8')


def patch_hudlayer(hud: str, panel_yaml: str) -> str:
    if 'GunMarksBattlePanel' in hud:
        hud = strip_battle_patch(hud)

    if 'SessionDataModel' not in hud:
        hud = hud.replace(
            '            - ["HudModel", "hudModel", "null", "{ }"]\n',
            '            - ["HudModel", "hudModel", "null", "{ }"]\n' + SESSION_PARAM,
        )

    mission_line = '            - ["string", "missionText", '
    if 'playerTank' not in hud:
        hud = hud.replace(
            mission_line,
            TANK_BINDING + mission_line,
            1,
        )

    marker = '    -   class: "UIControl"\n        name: "AllyTeamPanelContainer"'
    if marker not in hud:
        raise RuntimeError('AllyTeamPanelContainer not found in HUDLayer.yaml')
    return hud.replace(marker, panel_yaml.rstrip() + '\n' + marker, 1)


def strip_battle_patch(hud: str) -> str:
    """Убрать старый патч (панели + session + playerDossier)."""
    start = hud.find('    -   class: "UIControl"\n        name: "TankStatsBattlePanel"')
    if start < 0:
        start = hud.find('    -   class: "UIControl"\n        name: "GunMarksBattlePanel"')
    end = hud.find('    -   class: "UIControl"\n        name: "AllyTeamPanelContainer"')
    if start >= 0 and end > start:
        hud = hud[:start] + hud[end:]
    hud = hud.replace(SESSION_PARAM, '')
    hud = hud.replace(TANK_BINDING, '')
    hud = hud.replace(OLD_DOSSIER_BINDING, '')
    return hud


def write_dvpl(rel_path: str, yaml_text: str) -> Path:
    out = OUT_DATA / Path(*rel_path.split('/'))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(encode_dvpl(yaml_text.encode('utf-8'), compression=1))
    return out


def restore_vanilla_hud_to_game() -> None:
    target = GAME / 'Data' / 'UI' / 'Screens' / 'Battle' / 'HUDLayer.yaml.dvpl'
    if not VANILLA_HUD.is_file():
        raise RuntimeError('vanilla HUDLayer.yaml missing')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(encode_dvpl(VANILLA_HUD.read_text(encoding='utf-8').encode('utf-8')))
    print('Restored vanilla HUD to', target)


def main() -> None:
    print('Gun marks mod pack builder (v3 OwnedTank, panel always visible)')
    if not MOD_HANGAR.is_file():
        raise SystemExit(f'Hangar mod not found: {MOD_HANGAR}')
    if not PANEL.is_file():
        raise SystemExit(f'Panel template missing: {PANEL}')

    hangar_mod = MOD_HANGAR.read_text(encoding='utf-8')
    hud = patch_hudlayer(load_vanilla_hud(), PANEL.read_text(encoding='utf-8'))

    hangar_out = write_dvpl('UI/Screens3/Lobby/Hangar/Hangar.yaml.dvpl', hangar_mod)
    hud_out = write_dvpl('UI/Screens/Battle/HUDLayer.yaml.dvpl', hud)

    print('Built:')
    print(' ', hangar_out)
    print(' ', hud_out)
    print('Lines HUD:', len(hud.splitlines()))


def install_to_game() -> None:
    import shutil
    src = OUT_DATA / 'UI'
    dst = GAME / 'Data' / 'UI'
    for rel in [
        'Screens/Battle/HUDLayer.yaml.dvpl',
        'Screens3/Lobby/Hangar/Hangar.yaml.dvpl',
    ]:
        s = src / Path(*rel.split('/'))
        t = dst / Path(*rel.split('/'))
        t.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(s, t)
        print('Installed', t)


if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == '--restore-vanilla':
        restore_vanilla_hud_to_game()
    elif len(sys.argv) > 1 and sys.argv[1] == '--install-game':
        main()
        install_to_game()
    else:
        main()
