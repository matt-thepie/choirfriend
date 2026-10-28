"""Staff-aware note-head locator for scanned choral scores.

usage: omr.py page.png OUTDIR --clefs treble,treble,bass,bass [--staves-per-system 6]

For each system on the page it finds the staves (groups of five evenly spaced
long horizontal lines), crops the first len(clefs) staves (the vocal ones),
locates filled and hollow note-heads, names their pitch from the staff
geometry and writes
  OUTDIR/<page>_sys<N>_<i>.png   annotated crop (pitch written above each head)
  stdout                         one line per staff: heads grouped by bar line
Flags, rests, dots, ties and lyrics are deliberately NOT read: check them by
eye on the annotated crop.  Hollow heads are suffixed with 'o'.
"""
import argparse, os, numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as ndi

ap = argparse.ArgumentParser()
ap.add_argument("page"); ap.add_argument("outdir")
ap.add_argument("--clefs", default="treble,treble,bass,bass")
ap.add_argument("--min-spacing", type=float, default=15.5, help="staff spacing (px) below which a staff is treated as piano and skipped")
ap.add_argument("--names", default="")
a = ap.parse_args()
clefs = a.clefs.split(",")
names = a.names.split(",") if a.names else [f"v{i+1}" for i in range(len(clefs))]
os.makedirs(a.outdir, exist_ok=True)
tag = os.path.splitext(os.path.basename(a.page))[0]

page = Image.open(a.page).convert("L")
# ---- deskew: pick the small rotation that makes the row projection sharpest
raw = np.array(page) < 140
best = None
for ang in np.arange(-1.0, 1.01, 0.1):
    rot = ndi.rotate(raw.astype(np.uint8), ang, reshape=False, order=0)
    v = rot.sum(axis=1).var()
    if best is None or v > best[0]: best = (v, ang)
skew = best[1]
page = page.rotate(skew, resample=Image.BILINEAR, fillcolor=255)
img = np.array(page)
ink = img < 140
H, W = ink.shape

# ---- staff lines: long horizontal runs
op = ndi.binary_opening(ink, structure=np.ones((1, 60)))
rowfill = op.sum(axis=1) / W
rows = np.where(rowfill > 0.15)[0]
groups = []
for r in rows:
    if groups and r - groups[-1][-1] <= 3: groups[-1].append(r)
    else: groups.append([r])
lines = [np.mean(g) for g in groups]
# group into staves: top line + 4 more at multiples of a spacing (allow one missing)
staves, used = [], set()
for i, l in enumerate(lines):
    if i in used: continue
    for sp in np.arange(13.0, 20.01, 0.25):
        found = [(0, l)]
        for k in range(1, 5):
            c = [(j, m) for j, m in enumerate(lines) if abs(m - (l + k * sp)) < 2.0]
            if c: found.append((k, c[0][1]))
        if len(found) >= 4 and found[-1][0] == 4:
            ks = np.array([f[0] for f in found]); ys = np.array([f[1] for f in found])
            sp_fit, top_fit = np.polyfit(ks, ys, 1)
            staves.append([top_fit + k * sp_fit for k in range(5)])
            for j, m in enumerate(lines):
                if any(abs(m - (top_fit + k * sp_fit)) < 2.0 for k in range(5)): used.add(j)
            break
staves = [st for st in staves if np.mean(np.diff(st)) >= a.min_spacing]

def line_offset(st, x0, x1):
    """vertical offset of the 5-line comb that best matches ink in columns x0:x1"""
    sp = np.mean(np.diff(st)); y0 = int(st[0] - 2 * sp); y1 = int(st[-1] + 2 * sp)
    prof = ink[y0:y1, x0:x1].mean(axis=1)
    best = None
    for d in np.arange(-8, 8.01, 0.5):
        sc = sum(prof[int(round(l + d - y0))] for l in st if 0 <= int(round(l + d - y0)) < len(prof))
        if best is None or sc > best[0]: best = (sc, d)
    return best[1]
slopes = []
for st in staves:
    xl, xr = int(W * 0.12), int(W * 0.88)
    dl = line_offset(st, xl, int(W * 0.35)); dr = line_offset(st, int(W * 0.65), xr)
    slopes.append(((dr - dl) / ((W * 0.65 + xr) / 2 - (xl + W * 0.35) / 2), dl, (xl + W * 0.35) / 2))
systems = [list(zip(staves[i:i + len(clefs)], slopes[i:i + len(clefs)])) for i in range(0, len(staves), len(clefs))]
print(f"# {tag}: skew {skew:+.1f} deg, {len(staves)} vocal staves -> {len(systems)} systems; staff slopes px/1000px: {[round(s[0]*1000,1) for s in slopes]}")

letters = "CDEFGAB"
def pitch_name(clef, step):
    base = {"treble": ("E", 4), "bass": ("G", 2)}[clef]
    k = letters.index(base[0]) + step
    return f"{letters[k % 7]}{base[1] + k // 7}"

font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 26)

for si, system in enumerate(systems):
    for vi, clef in enumerate(clefs):
        if vi >= len(system): break
        st, (slope, dl, xl) = system[vi]; sp = np.mean(np.diff(st)); top, bottom = st[0], st[-1]
        def local_bottom(x): return bottom + dl + slope * (x - xl)
        y0, y1 = int(top - 3.5 * sp), int(bottom + 3.5 * sp)
        crop = ink[y0:y1, :]
        # kill the staff lines themselves (they confuse the opening) by closing vertically first
        work = ndi.binary_closing(crop, structure=np.ones((3, 3)))
        ry, rx = max(int(sp * 0.22), 3), max(int(sp * 0.32), 4)
        yy, xx = np.ogrid[-ry:ry + 1, -rx:rx + 1]
        ell = (xx / rx) ** 2 + (yy / ry) ** 2 <= 1
        opened = ndi.binary_opening(work, structure=ell)
        lab, n = ndi.label(opened)
        heads = []
        for k, sl in enumerate(ndi.find_objects(lab), start=1):
            h = sl[0].stop - sl[0].start; w = sl[1].stop - sl[1].start
            if not (0.9 * sp <= h <= 1.5 * sp and 1.2 * sp <= w <= 2.0 * sp): continue
            mask = lab[sl] == k
            if mask.sum() < 0.55 * w * h: continue
            cy, cx = ndi.center_of_mass(mask)
            cy += sl[0].start + y0; cx += sl[1].start
            # hollow if the original ink in the central core is sparse
            hollow = False
            step = round((local_bottom(cx) - cy) / (sp / 2))
            heads.append((cx, cy, pitch_name(clef, step), hollow))
        heads.sort()
        # bar lines: columns dark over the full staff height, thin
        colfill = ink[int(top) - 1:int(bottom) + 2, :].mean(axis=0)
        cols = np.where(colfill > 0.92)[0]
        bars = []
        for x in cols:
            if bars and x - bars[-1][-1] <= 2: bars[-1].append(x)
            else: bars.append([x])
        bars = [np.mean(g) for g in bars if len(g) <= 5]
        # drop "bar lines" that are really stems: a stem touches a head within 1.2*sp horizontally
        bars = [b for b in bars if not any(abs(b - hx) < 1.2 * sp and abs(hy - (top + bottom) / 2) < 3 * sp for hx, hy, _, _ in heads)]
        out, bi = [], 0
        for cx, cy, nm, hol in heads:
            while bi < len(bars) and bars[bi] < cx:
                out.append("|"); bi += 1
            out.append(nm + ("o" if hol else ""))
        print(f"{tag} sys{si+1} {names[vi]:3s} ({clef}): " + " ".join(out))
        # annotated crop
        ann = Image.fromarray((~crop * 255).astype(np.uint8)).convert("RGB")
        d = ImageDraw.Draw(ann)
        for j, (cx, cy, nm, hol) in enumerate(heads):
            yy_ = cy - y0
            d.ellipse([cx - 4, yy_ - 4, cx + 4, yy_ + 4], outline=(255, 0, 0), width=2)
            ty = 2 if j % 2 == 0 else y1 - y0 - 30
            d.text((cx - 14, ty), nm + ("o" if hol else ""), fill=(200, 0, 0), font=font)
        for b in bars:
            d.line([b, 0, b, y1 - y0], fill=(0, 120, 255), width=1)
        ann.save(os.path.join(a.outdir, f"{tag}_sys{si+1}_{names[vi]}.png"))
