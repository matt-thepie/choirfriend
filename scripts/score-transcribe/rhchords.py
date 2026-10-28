"""Find note-heads in a piano RH staff strip by ellipse template matching; print heads grouped by x into chords.
usage: rhchords.py page.png staff_top staff_bottom x0 x1 [annotate.png]"""
import sys, numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from scipy.signal import fftconvolve
Image.MAX_IMAGE_PIXELS=None
THR=float(__import__("os").environ.get("THR","0.35")); FILL=float(__import__("os").environ.get("FILL","0.6"))
pg, t, b, x0, x1 = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
out = sys.argv[6] if len(sys.argv)>6 else None
im = Image.open(pg).convert('L'); W=im.width
strip = np.array(im.crop((x0, t-60, x1, b+60))) < 140
# staff lines: rows with long ink runs, refit per column band to handle skew -> use global here
rows = strip.sum(axis=1); lines=[]
for y in range(len(rows)):
    if rows[y] > 0.3*(x1-x0):
        if lines and y-lines[-1][-1] <= 2: lines[-1].append(y)
        else: lines.append([y])
ly = [np.mean(g) for g in lines]
if len(ly)>5:   # a beam can masquerade as a line: keep the 5 most evenly spaced
    best=None
    for i in range(len(ly)-4):
        d=np.diff(ly[i:i+5]); v=d.max()-d.min()
        if best is None or v<best[0]: best=(v,i)
    ly=ly[best[1]:best[1]+5]
assert len(ly)==5, ly
sp = (ly[4]-ly[0])/4          # staff space
# fit slope: for column bands, locate each line's local y (max ink row near ly[i])
def line_at(i, x):
    return ly[i] + slope*(x - strip.shape[1]/2)
bands=[(c, c+200) for c in range(0, strip.shape[1]-200, 200)]
pts=[]
for c0,c1 in bands:
    sub=strip[:, c0:c1].sum(axis=1)
    for i,y0 in enumerate(ly):
        yy=int(round(y0)); win=sub[yy-4:yy+5]
        if win.max() > 0.4*(c1-c0): pts.append(((c0+c1)/2, yy-4+int(win.argmax())-y0))
xs=np.array([p[0] for p in pts]); dy=np.array([p[1] for p in pts])
slope = np.polyfit(xs-strip.shape[1]/2, dy, 1)[0] if len(xs)>3 else 0.0
# remove staff lines (thin) so heads separate from lines
nolines = strip.copy()
for y in ly:
    yy=int(round(y)); nolines[yy-1:yy+2,:] = False
# ellipse template ~ head size: width 1.3sp, height 0.9sp
h = int(round(sp*0.95)); w = int(round(sp*1.25))
yy, xx = np.mgrid[-h//2:h//2+1, -w//2:w//2+1]
tmpl = ((xx/(w/2))**2 + (yy/(h/2))**2) <= 1.0
tmpl = tmpl.astype(float); tmpl -= tmpl.mean()
score = fftconvolve(strip.astype(float), tmpl[::-1, ::-1], mode='same')
score /= tmpl.var()*tmpl.size
# local maxima
mx = ndi.maximum_filter(score, size=(int(sp*1.0), int(sp*1.0)))
peaks = np.argwhere((score==mx) & (score>THR))
# filled check: fraction of ink inside ellipse
heads=[]
for y,x in peaks:
    ys, xs = slice(max(0,y-h//2), y+h//2+1), slice(max(0,x-w//2), x+w//2+1)
    if strip[ys, xs].mean() > FILL: heads.append((x,y))
# pitch: steps above bottom line (E4 for treble)
names = ['E4','F4','G4','A4','B4','C5','D5','E5','F5','G5','A5','B5']
low = ['D4','C4','B3','A3','G3','F3']
def pitch(y, x=None):
    base = line_at(4, x) if x is not None else ly[4]
    step = (base-y)/(sp/2); s=int(round(step))
    if s>=0: return names[s] if s<len(names) else f'+{s}'
    return low[-s-1] if -s-1 < len(low) else f'{s}'
heads.sort()
# dedupe peaks closer than 0.6 sp
ded=[]
for x,y in heads:
    if any(abs(x-a)<sp*0.6 and abs(y-b)<sp*0.6 for a,b in ded): continue
    ded.append((x,y))
heads=ded
# group by x into chords
chords=[]
for x,y in heads:
    if chords and x-chords[-1][-1][0] < sp*0.7: chords[-1].append((x,y))
    else: chords.append([(x,y)])
print(' '.join('+'.join(pitch(y,x) for x,y in sorted(c, key=lambda p:p[1])) + f'@{x0+c[0][0]}' for c in chords))
if out:
    img = im.crop((x0, t-60, x1, b+60)).convert('RGB'); d=ImageDraw.Draw(img)
    for x,y in heads: d.ellipse((x-4,y-4,x+4,y+4), outline='red', width=2); d.text((x-8,y-28), pitch(y,x), fill='red')
    img.resize((img.width*2, img.height*2)).save(out)
