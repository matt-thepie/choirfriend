"""Hide playback-only marks in a MuseScore file (MusicXML import drops print-object on dynamics/wedges).

usage: hide_marks.py in.mscz out.mscz STAFF:BAR:Dynamic:SUBTYPE ... STAFF:BAR:HairPin ...
Each spec hides the first matching element in that staff's bar (bars count from 1; staves from 1).
"""
import re
import sys
import zipfile

src, dst, *specs = sys.argv[1:]
zin = zipfile.ZipFile(src)
name = next(n for n in zin.namelist() if n.endswith(".mscx"))
x = zin.read(name).decode()

def staff_span(x, sid):
    a = x.index(f'<Staff id="{sid}">', x.index("</Part>", x.rindex("<Part")))  # music body, after the part headers
    return a, x.index("</Staff>", a)

for spec in specs:
    sid, b, kind, *sub = spec.split(":")
    a, z = staff_span(x, sid)
    ms = [m.start() for m in re.finditer(r"<Measure[ >]", x[a:z])]
    m0 = a + ms[int(b) - 1]; m1 = x.index("</Measure>", m0)
    seg = x[m0:m1]
    if kind == "Dynamic":
        hit = re.search(rf"<Dynamic>\s*<subtype>{re.escape(sub[0])}</subtype>", seg)
        tag = "<Dynamic>"
    else:
        hit = re.search(r'<Spanner type="HairPin">\s*<HairPin>', seg)
        tag = "<HairPin>"
    if not hit: raise SystemExit(f"{spec}: not found")
    at = m0 + hit.start() + hit.group(0).index(tag) + len(tag)
    x = x[:at] + "\n          <visible>0</visible>" + x[at:]
    print("hid", spec)

with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
    for n in zin.namelist():
        zout.writestr(n, x if n == name else zin.read(n))
