"""Detect filled heads on every piano staff of the scan and diff against build_only_you tokens."""
import subprocess, re, sys, os
sys.path.insert(0, '/Users/mgd/github/choirfriend/choirfriend/scripts/score-transcribe')
SYS = {  # (page, RH top, RH bottom, LH top, LH bottom, first bar, nbars)
 'p1s2': (1, 2938, 2996, 3157, 3214, 5, 3), 'p2s1': (2, 1335, 1392, 1549, 1607, 8, 3),
 'p2s2': (2, 2932, 2992, 3151, 3208, 11, 3), 'p3s1': (3, 1279, 1337, 1481, 1539, 14, 3),
 'p3s2': (3, 2926, 2985, 3145, 3203, 17, 4), 'p4s1': (4, 1215, 1272, 1431, 1488, 21, 4),
 'p4s2': (4, 2939, 2998, 3158, 3215, 25, 4), 'p5s1': (5, 1266, 1323, 1479, 1538, 29, 4),
 'p5s2': (5, 2922, 2980, 3143, 3202, 33, 4)}
src = open('/Users/mgd/github/choirfriend/choirfriend/scripts/score-transcribe/build_only_you.py').read()
ns = {}
exec(src.split('rh = build_staff')[0], ns)   # tokens only, no score build
def expected(tok_up, tok_lo):
    """filled-head pitch sets per onset (durations < 2 beats), merged from two token strings, lower octave names kept"""
    def parse(tok):
        out=[]; pos=0.0
        for t in tok.split():
            t=t.strip('()')
            m=re.match(r'([A-Gr][#b]?\d?(?:\+[A-G][#b]?\d)*)/(\d+)(\.?)(~?)', t)
            if not m: continue
            ps, d, dot, tie = m.groups(); dur = 4/int(d)*(1.5 if dot else 1)
            if ps!='r' and dur<2: out.append((round(pos,3), set(p.replace('#','') for p in ps.split('+'))))
            pos += dur
        return out
    a=parse(tok_up); b=parse(tok_lo); m={}
    for pos,ps in a+b: m.setdefault(pos,set()).update(ps)
    return [m[k] for k in sorted(m)]
def detect(p, t, b, clef):
    out = subprocess.run(['venv/bin/python', 'rhchords.py', f'pages/p-{p}.png', str(t), str(b), '280', '2360'], capture_output=True, text=True).stdout.strip()
    chords=[]
    for c in out.split():
        names = c.split('@')[0].split('+')
        if clef=='bass':  # treble names -> bass: same staff position is 2 steps + octave lower (E4 line -> G2)
            steps = {'C':0,'D':1,'E':2,'F':3,'G':4,'A':5,'B':6}; inv='CDEFGAB'
            conv=[]
            for n in names:
                s = steps[n[0]] + 7*int(n[1]); s -= 12 + 2*0   # treble->bass: E4(30) -> G2(18) = -12
                conv.append(inv[s%7]+str(s//7))
            names=conv
        chords.append(set(names))
    return chords
bad=0
for name,(p,rt,rb,lt,lb,b0,n) in SYS.items():
    for hand,(t,b,clef,up,lo) in {'RH':(rt,rb,'treble',ns['PT1'],ns['PT2']),'LH':(lt,lb,'bass',ns['B1'],ns['PB2'])}.items():
        exp=[]; 
        for bar in range(b0,b0+n): exp += expected(up[bar], lo[bar])
        det=detect(p,t,b,clef)
        ok = exp==det
        print(f'{name} {hand} bars {b0}-{b0+n-1}: {"OK" if ok else "DIFF"}')
        if not ok:
            bad+=1
            print('  expected:', ' '.join('+'.join(sorted(s)) for s in exp))
            print('  detected:', ' '.join('+'.join(sorted(s)) for s in det))
print('systems with differences:', bad)
