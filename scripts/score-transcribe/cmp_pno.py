"""Stack the render's piano system over the scan's, in thirds at 2x. usage: cmp_pno.py page"""
import sys, numpy as np
from PIL import Image
p=int(sys.argv[1])
def staves(im, lo, hi):
    a=np.array(im)<150; rows=a.sum(axis=1); W=a.shape[1]
    ys=[]; 
    for y in range(len(rows)):
        if rows[y]>0.35*W:
            if ys and y-ys[-1][-1]<=2: ys[-1].append(y)
            else: ys.append([y])
    ys=[int(np.mean(g)) for g in ys]
    out=[]; i=0
    while i+4<len(ys):
        d=np.diff(ys[i:i+5])
        if d.max()-d.min()<=3 and lo<d.mean()<hi: out.append((ys[i],ys[i+4])); i+=5
        else: i+=1
    return out
scan=Image.open(f'pages/p-{p}.png').convert('L')
rend=Image.open(f'oyf-{p}.png').convert('L').resize((scan.width, int(Image.open(f'oyf-{p}.png').height*scan.width/Image.open(f'oyf-{p}.png').width)), Image.LANCZOS)
# ensure render has white bg (mscore PNG is transparent)
r0=Image.open(f'oyf-{p}.png').convert('RGBA'); bg=Image.new('RGBA',r0.size,'white'); bg.alpha_composite(r0)
rend=bg.convert('L').resize(rend.size, Image.LANCZOS)
ss=staves(scan,12,16)   # scan piano staves are the small ones
rs=staves(rend,8,40)
print('scan',ss); print('rend',rs)
# render: systems of 6 staves -> last two
rsys=[(rs[k+4][0],rs[k+5][1]) for k in range(0,len(rs)-5,6)]
ssys=[(ss[k][0],ss[k+1][1]) for k in range(0,len(ss)-1,2)]
if p==3: ssys=[(1279,1539)]+ssys
print(rsys, ssys)
for n,((rt,rb),(st,sb)) in enumerate(zip(rsys,ssys),1):
    for i in range(3):
        W=scan.width; x0=max(0,i*W//3-80); x1=min(W,(i+1)*W//3+80)
        a=rend.crop((x0,rt-110,x1,rb+80)); b=scan.crop((x0,st-110,x1,sb+80))
        h=a.height+b.height; out=Image.new('L',(x1-x0,h+10),128); out.paste(a,(0,0)); out.paste(b,(0,a.height+10))
        out.resize((out.width*2,out.height*2),Image.LANCZOS).save(f'pno/c{p}s{n}{"abc"[i]}.png')
