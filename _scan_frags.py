import zipfile
import pickle
import sys

sys.path.insert(0, r'e:\Стримерская\2.3\src\modules\replay-live')
from parse_battle_results import read_varint

path = sys.argv[1]
with zipfile.ZipFile(path) as zf:
    raw = zf.read('battle_results.dat')
try:
    obj = pickle.loads(raw, encoding='bytes')
except TypeError:
    obj = pickle.loads(raw)
pb = obj[1] if isinstance(obj, tuple) and len(obj) > 1 else raw
if not isinstance(pb, (bytes, bytearray)):
    pb = bytes(pb)

# dump all fields from combat sub with damage 1503
for i in range(len(pb) - 20):
    if pb[i] != 0x12:
        continue
    ln, sub_start = read_varint(pb, i + 1)
    if ln is None or ln < 15:
        continue
    sub = pb[sub_start:sub_start + ln]
    fields = {}
    off = 0
    while off < len(sub) - 1:
        tag = sub[off]
        off += 1
        field = tag >> 3
        wire = tag & 7
        if wire == 0:
            val, off = read_varint(sub, off)
            if val is None:
                break
            fields[field] = val
        elif wire == 2:
            l2, off = read_varint(sub, off)
            if l2 is None:
                break
            off += l2
        elif wire == 5:
            off += 4
        elif wire == 1:
            off += 8
        else:
            break
    dmg = fields.get(8, 0)
    if dmg in (1503, 3381, 4609, 2897):
        print('damage', dmg, 'len', ln, 'fields', dict(sorted(fields.items())))

# search for 7 and 3 as varints near common score patterns
for target in (7, 3, 10):
    count = pb.count(bytes([target]))  # naive
print('pb len', len(pb))
