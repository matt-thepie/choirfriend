"""Beam every run of consecutive quavers in a bar as one group on the given staves (.mscz in -> out).
Piano reductions often beam a whole bar of repeated chords (6 in 3/4, 8 in 4/4); MuseScore's default
groups them by beat. Rests break a run. Run after fix_jumps.py, which drops music21's explicit beams.

usage: beam_runs.py in.mscz out.mscz STAFF[,STAFF...] [--skip STAFF:BAR,BAR]
  --skip 5:1   leave bar 1 of staff 5 with MuseScore's default beaming
"""
import re, sys, zipfile, os, shutil, tempfile

src, dst, staves = sys.argv[1], sys.argv[2], sys.argv[3].split(",")
SKIP = {}
for i, a in enumerate(sys.argv):
    if a == "--skip":
        st, bars = sys.argv[i + 1].split(":")
        SKIP.setdefault(st, set()).update(int(b) for b in bars.split(","))
tmp = tempfile.mkdtemp()
with zipfile.ZipFile(src) as z:
    z.extractall(tmp); names = z.namelist()
path = os.path.join(tmp, [n for n in names if n.endswith(".mscx")][0])
x = open(path, encoding="utf-8").read()

ITEM = re.compile(r"<(Chord|Rest)>.*?</\1>", re.S)
def beam_voice(v):
    items = list(ITEM.finditer(v)); runs, cur = [], []
    for it in items:
        q = it.group(1) == "Chord" and "<durationType>eighth</durationType>" in it.group(0) and "<dots>" not in it.group(0)
        if q: cur.append(it)
        else:
            if len(cur) > 1: runs.append(cur)
            cur = []
    if len(cur) > 1: runs.append(cur)
    out, pos = [], 0
    for run in runs:
        for k, it in enumerate(run):
            body = re.sub(r"\s*<BeamMode>\w+</BeamMode>", "", it.group(0))
            body = re.sub(r"(<Chord>\s*(?:<eid>[^<]*</eid>\s*)?)", r"\1<BeamMode>%s</BeamMode>\n" % ("begin" if k == 0 else "mid"), body, count=1)
            out.append(v[pos:it.start()]); out.append(body); pos = it.end()
    out.append(v[pos:])
    return "".join(out)

def staff(m):
    sid = m.group(1)
    if sid not in staves: return m.group(0)
    n = [0]
    def meas(mm):
        n[0] += 1
        if n[0] in SKIP.get(sid, ()): return mm.group(0)
        return re.sub(r"<voice>.*?</voice>", lambda v: beam_voice(v.group(0)), mm.group(0), flags=re.S)
    return re.sub(r"<Measure>.*?</Measure>", meas, m.group(0), flags=re.S)
x = re.sub(r'<Staff id="(\d+)">.*?</Staff>', staff, x, flags=re.S)
open(path, "w", encoding="utf-8").write(x)
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
    for nm in names: z.write(os.path.join(tmp, nm), nm)
shutil.rmtree(tmp)
print("beamed staves", staves)
