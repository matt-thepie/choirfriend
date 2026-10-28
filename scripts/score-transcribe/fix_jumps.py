"""Turn MuseScore-imported StaffText 'Fine' / 'D.S. al Fine' / segno into real Marker/Jump
objects inside an .mscz so playback and MIDI export honour the repeat structure.

MuseScore 4 reads <Marker>/<Jump> as direct children of <Measure> (siblings of <voice>),
so the StaffText is removed from the voice and the object inserted at measure level.

usage: fix_jumps.py in.mscz out.mscz
"""
import re, sys, zipfile, shutil, os, tempfile

src, dst = sys.argv[1], sys.argv[2]
tmp = tempfile.mkdtemp()
with zipfile.ZipFile(src) as z:
    z.extractall(tmp)
    names = z.namelist()
mscx = [n for n in names if n.endswith(".mscx")][0]
path = os.path.join(tmp, mscx)
x = open(path, encoding="utf-8").read()

RULES = [
    (r"<sym>segno</sym>", "<Marker><style>repeat_left</style><text><sym>segno</sym></text><label>segno</label><markerType>segno</markerType></Marker>"),
    (r"Fine", "<Marker><style>repeat_right</style><text>Fine</text><label>fine</label><markerType>fine</markerType></Marker>"),
    (r"D\.S\. al Fine", "<Jump><style>repeat_right</style><text>D.S. (Verse 3) al Fine</text><jumpTo>segno</jumpTo><playUntil>fine</playUntil><continueAt></continueAt></Jump>"),
]
counts = []
for inner, repl in RULES:
    pat = re.compile(r"<StaffText>\s*(?:<eid>[^<]*</eid>\s*)?<text>" + inner + r"</text>\s*</StaffText>\s*")
    n = 0
    while True:
        m = pat.search(x)
        if not m:
            break
        n += 1
        x = x[:m.start()] + x[m.end():]                       # drop the StaffText
        mstart = x.rfind("<Measure", 0, m.start())            # enclosing measure
        ins = x.index(">", mstart) + 1
        x = x[:ins] + "\n        " + repl + x[ins:]
    counts.append(n)
print("replaced segno/fine/ds:", counts)
# Lyric rest glyphs: MusicXML can't carry a SMuFL symbol in a lyric, so the build writes
# the placeholder RESTSYL and we swap in MuseScore's own <sym> markup here.
n_rest = x.count("<text>RESTSYL</text>")
# <sym>restEighth</sym> and U+1D13E both render blank in MS 4.x lyrics; forcing the Leland
# music font plus the SMuFL private-use codepoint (U+E4E6 = restEighth) does render.
x = x.replace("<text>RESTSYL</text>", '<text><font face="Leland"/>\uE4E6</text>')
# bracketed fermatas (last time only): "(" + SMuFL fermataAbove/Below in Leland + ")"
x = x.replace("<text>FERMSYL</text>", '<text>(<font face="Leland"/>\uE4C0<font face="Edwin"/>)</text>')
# MuseScore's MusicXML import puts the piano LH (music21 staff-2 voices) into MS voice 2, with a hidden
# whole-bar filler rest in voice 1 - so its rests sit under the staff and stems point the wrong way. Where a
# bar has two real voices the LOWER part lands in voice 1. Put the upper line back in voice 1: swap the two
# <voice> blocks, keep the Clef/KeySig/TimeSig header at the top of voice 1, drop the filler rest.
HEADER = re.compile(r"^(\s*<voice>)((?:\s*<(?:Clef|KeySig|TimeSig)>.*?</(?:Clef|KeySig|TimeSig)>)*)", re.S)
FILLER = re.compile(r"^\s*<voice>\s*(?:<Rest>(?:(?!</Rest>).)*<durationType>measure</durationType>(?:(?!</Rest>).)*</Rest>)\s*</voice>\s*$", re.S)
def swap_voices(staff_xml):
    def fix(m):
        vs = re.findall(r"<voice>.*?</voice>", m.group(0), re.S)
        if len(vs) != 2: return m.group(0)
        h = HEADER.match(vs[0]); header = h.group(2); v0 = vs[0][:h.start(2)] + vs[0][h.end(2):]
        v1 = vs[1].replace("<voice>", "<voice>" + header, 1)
        v0 = "" if FILLER.match(v0) else v0
        return m.group(0).replace(vs[0], "\x00").replace(vs[1], v0).replace("\x00", v1)
    out = re.sub(r"<Measure>.*?</Measure>", fix, staff_xml, flags=re.S)
    return re.sub(r"\s*<StemDirection>\w+</StemDirection>", "", out)  # let voice decide stem direction
x = re.sub(r'<Staff id="[56]">.*?</Staff>', lambda m: swap_voices(m.group(0)), x, flags=re.S)
x = x.replace("<text>FERMSYLB</text>", '<text>(<font face="Leland"/>\uE4C1<font face="Edwin"/>)</text>')
print("lyric rest glyphs:", n_rest)
open(path, "w", encoding="utf-8").write(x)
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
    for n in names:
        z.write(os.path.join(tmp, n), n)
shutil.rmtree(tmp)
