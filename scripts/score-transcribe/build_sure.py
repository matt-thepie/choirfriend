"""Build Sure on this Shining Night (Barber/Agee, SATB + piano, HL50308930) as MusicXML.

Same token syntax as build_only_you.py, plus:
  * written pitches in the 2-flat key: plain B / E mean B-flat / E-flat, `Bn`/`En` are naturals,
    `#` sharps. Accidentals carry to the end of the bar on that staff, as in print.
  * `h/2` = hidden rest (a gap in a secondary voice), `!` suffix = fermata, `@` suffix = arpeggio
  * piano bars may hold two voices: "upper tokens || lower tokens"
Every bar was read off the deskewed scan; pitches were checked with probe.py (fractional staff steps).
"""
import os
import re
from music21 import (stream, note, chord, meter, key, clef, tempo, bar, expressions, spanner, metadata,
                     instrument, duration, tie, layout, dynamics, articulations)

S = {
 1: "r/2.", 2: "D5/4 C5/8 D5/8 B4/8 A4/8", 3: "C5/4. B4/8 A4/8 B4/8", 4: "G4/8 F4/8 A4/2",
 5: "r/4 r/4 B4/4~", 6: "B4/4 A4/8 B4/8 G4/8 F4/8", 7: "A4/2 G4/4", 8: "E4/4. F4/8 D4/4~", 9: "D4/2",
 10: "r/4 r/4 D5/4", 11: "F5/4 En5/8 F5/8 D5/8 C5/8", 12: "En5/2.", 13: "G5/2~ G5/8 En5/8", 14: "En5/2.",
 15: "En5/2 D5/4", 16: "F5/2.", 17: "r/4 F5/4 En5/8 D5/8 C5/8 D5/8", 18: "B4/2.", 19: "r/4 D5/2~ D5/8 G4/8",
 20: "G4/2.", 21: "r/2.", 22: "F5/4 E5/8 F5/8 D5/8 C5/8", 23: "E5/4. D5/8 C5/8 D5/8", 24: "B4/8( A4/8) C5/2~",
 25: "C5/4 r/4 D5/4~", 26: "D5/4 C5/8( D5/8) B4/8 A4/8", 27: "C5/2 B4/4", 28: "G4/4. A4/8 F4/4~",
 29: "F4/4 G4/2", 30: "D4/2.", 31: "r/2.", 32: "r/4 D4/2~", 33: "D4/8 C4/8 E4/4~ E4/8 D4/8", 34: "F4/2.!",
}
A = {
 1: "r/2.", 2: "F4/2( D4/4)", 3: "A4/4( G4/4) F4/4", 4: "B3/4 F4/2", 5: "G4/2~ G4/8 r/8", 6: "G4/4 F4/4 A3/4",
 7: "A3/2 B3/8( D4/8)", 8: "G3/2~ G3/8 r/8", 9: "B3/2", 10: "A3/4 A3/2", 11: "D4/4( F4/4) A4/4",
 12: "C5/4 Bn4/8 C5/8 A4/8 G4/8", 13: "Bn4/2 G4/4", 14: "A4/2.", 15: "A4/2 En4/4", 16: "A4/4 A4/4~ A4/8 A4/8",
 17: "B4/2~ B4/8 F4/4 F4/8", 18: "G4/2 G4/4", 19: "D4/2~ D4/8 D4/4 C4/8", 20: "E4/2.", 21: "r/2.",
 22: "A4/4 G4/8 G4/8 D4/8 D4/8", 23: "G4/4( F4/8) F4/8 A4/8 F4/8", 24: "D4/4 C4/4 B4/4~",
 25: "B4/4 A4/8( B4/8) G4/8 F4/8", 26: "A4/2 G4/4", 27: "E4/4. F4/8 D4/4~", 28: "D4/2 E4/4", 29: "B3/2.~",
 30: "B3/2.", 31: "r/2.", 32: "r/4 B3/2~", 33: "B3/8 B3/8 B3/4~ B3/8 D4/8", 34: "D4/2.!",
}
T = {  # treble-8vb, written pitch
 1: "r/2.", 2: "r/2.", 3: "F5/4 E5/8 F5/8 D5/8 C5/8", 4: "E5/4. D5/8 C5/8 D5/8", 5: "B4/8 A4/8 C5/2~",
 6: "C5/8 r/8 r/4 D5/4~", 7: "D5/4 C5/8 D5/8 B4/8 A4/8", 8: "C5/2 B4/4", 9: "G4/4. A4/8", 10: "F4/2 F4/4",
 11: "A4/4 D5/4 F5/4", 12: "En5/4 En5/8 En5/8 C5/8 En5/8", 13: "Bn4/4 B4/4~ B4/8 B4/8", 14: "C#5/2.",
 15: "C#5/2 Bn4/4", 16: "D5/2.~", 17: "D5/2~ D5/8 D5/4 D5/8", 18: "D5/4. C5/8 E5/4", 19: "A4/4.( G4/8) B4/2",
 20: "B4/2.", 21: "D5/4 C5/8 D5/8 B4/8 A4/8", 22: "C5/4. B4/8 A4/8 B4/8", 23: "G4/8( F4/8) A4/2", 24: "G4/2.~",
 25: "G4/2 B4/4", 26: "F5/2 E5/4", 27: "G4/2 G4/4", 28: "G4/4 G4/2~", 29: "G4/4 G4/4 G4/4", 30: "F4/2.",
 31: "r/2.", 32: "r/4 G4/2~", 33: "G4/8 G4/8 G4/4~ G4/8 B4/8", 34: "B4/2.!",
}
B = {
 1: "r/2.", 2: "B3/2( G3/4)", 3: "E3/2 F3/4", 4: "G3/4 D3/2", 5: "E3/2.", 6: "E3/4 F3/4 F3/4", 7: "G3/2 G3/4",
 8: "C3/2 G2/4", 9: "D3/4 E3/4", 10: "D3/2.~", 11: "D3/2 D4/4", 12: "A3/2 A3/8 A3/8", 13: "En3/2 E3/4",
 14: "A2/4 A2/4. A2/8", 15: "A3/2.", 16: "D3/2 D3/4", 17: "B2/2.~ B2/8 r/8", 18: "G3/2.", 19: "G2/1",
 20: "E3/2.", 21: "B2/2 G3/4", 22: "E3/2 F3/4", 23: "B3/4 D3/2", 24: "E3/2.", 25: "E3/2 G3/4", 26: "D3/2 E3/4",
 27: "C3/2 D3/4", 28: "E3/4 E3/2", 29: "F3/4( E3/4) E3/4", 30: "B2/2.", 31: "r/2.", 32: "r/4 G2/2~",
 33: "G2/8 G2/8 E3/4~ E3/8 E3/8", 34: "B2/2.!",
}

def x(tok, n): return " ".join([tok] * n)
RH = {
 1: "F4+B4+D5/2.@ || D4/4. B3+D4/8 B3+D4/8 B3+D4/8", 2: "B3+D4/2.",
 3: x("C4+F4+A4/8", 2) + " " + x("C4+E4+G4/8", 2) + " " + x("D4+F4/8", 2),
 4: "B3+E4/8 B3+E4/8 h/2", 5: "r/2.", 6: "r/2.", 7: "h/2 B3/8 D4/8", 8: "E4/2 D4+B4/4",
 9: "G4/4. A4/8 || B3+D4/2", 10: "F4/4 " + x("A3+D4+F4/8", 4) + " || A3+D4/8 A3+D4/8 h/2",
 11: x("A3+D4+F4/8", 6), 12: x("A3+C4+En4/8", 6), 13: x("Bn3+En4+G4+Bn4/8", 6), 14: x("C#4+En4+A4+C#5/8", 6),
 15: x("C#4+En4+A4+C#5/8", 4) + " " + x("Bn3+En4+A4+Bn4/8", 2), 16: x("D4+F4+A4+D5/8", 6),
 17: x("D4+F4+B4+D5/8", 8), 18: x("D4+G4+B4+D5/8", 3) + " C4+G4+C5/8 " + x("E4+G4+B4+E5/8", 2),
 19: "G3+A3+D4/8 G3+A3+D4/8 G3+D4/8 G3+D4/8 G3+B3+D4/8 A3+D4/8 G3+B3+D4/8 G3+A3+C4/8",
 20: x("G3+B3+E4/8", 6), 21: x("D4+F4/8", 4) + " " + x("B3+D4/8", 2) + " || F3/2.",
 22: x("C4+F4+A4/8", 2) + " " + x("C4+E4+G4/8", 2) + " " + x("A3+D4+F4/8", 2),
 23: "E4/2 D4/4 || B3/8 B3/8 A3+C4/8 A3+C4/8 A3/8 A3/8",
 24: x("G3+B3+D4/8", 2) + " " + x("G3+C4/8", 4), 25: x("G3+C4/8", 4) + " " + x("G3+B3+D4/8", 2),
 26: x("A3+D4+F4/8", 4) + " " + x("C4+E4/8", 2), 27: x("G3+C4+E4/8", 4) + " G3+B3+D4/8 G3+B3/8",
 28: "D4/2 E4/4 || " + x("G3+B3/8", 6), 29: "B3/2.", 30: "h/8 " + x("D4+F4+B4+D5/8", 5),
 32: "r/4 " + x("G3+B3+D4/8", 4), 33: "G3+B3+D4/8 A3+C4/8 " + x("G3+B3+E4/8", 3) + " B3+D4/8",
 34: "B3+D4+F4/2.!",
}
RH[31] = RH[18]
LH = {
 1: "B2+F3/2.", 2: x("B2+F3/8", 4) + " " + x("G2+D3/8", 2), 3: "E2+E3/2 F2+F3/4",
 4: "E3/4 F3+A3+D4/8 F3+A3/8 F3+A3/8 F3+A3/8 || G2/4 D3/2", 5: x("E3+G3/8", 6),
 6: x("E3+G3/8", 2) + " " + x("F3+A3/8", 4), 7: x("G3+A3/8", 4) + " G3/8 G3/8",
 8: x("G3/8", 6) + " || C3/2 G2/4~", 9: "D3/8 D3/8 E3/8 E3/8 || G2/2", 10: "D2+D3/2.~", 11: "D2+D3/2.",
 12: "A2+En3/2.", 13: "En2+En3/2.", 14: "A2+En3/2.", 15: "A2+En3/2.", 16: "D2+A2+F3/2.@", 17: "B2+F3/1",
 18: "E3+G3/2.", 19: "G2+D3/1", 20: "E2+B2/2.", 21: "B1+B2/2 G2+D3/4", 22: "E2+C3/2 F2+D3/4",
 23: "G2+E3/4 D2+A2+F3/2@", 24: "B2/4 C3/2~ || E2/2.~", 25: "C3/2 G2+D3/4 || E2/2 h/4",
 26: "D2+A2+D3/2 E2+B2+E3/4", 27: "C2+C3/2 D2+D3/4", 28: "E2+B2/2.~",
 29: "F3+G3/8 F3+G3/8 " + x("E3+G3/8", 4) + " || E2+B2/2.", 30: "D3+F3/8 h/4 h/4. || B1+F2+B2/2.", 31: "E3+G3/2.",  # 30: D3+F3 starts the RH beam (cross-staff)
 32: "r/4 G2+D3/2~", 33: "G2+D3/4 E2+B2/2", 34: "r/4 B1+D3/2!",
}

LYR = {
 "S": {2: "Sure on this shin- -ing", 3: "night Of star- -made", 4: "shad- -ows round,", 5: "Kind-",
       6: "_ -ness must watch for", 7: "me This", 8: "side the ground.", 9: "_", 10: "The",
       11: "late year lies down the", 12: "north.", 13: "All _ is", 14: "healed,", 15: "all is", 16: "health.",
       17: "High sum- -mer holds the", 18: "earth.", 19: "Hearts _ all", 20: "whole.",
       22: "Sure on this shin- -ing", 23: "night I weep for", 24: "won- _ -der", 25: "_ wan-",
       26: "_ -d'ring _ far a-", 27: "-lone Of", 28: "shad- -ows on", 29: "_ the", 30: "stars.",
       32: "On", 33: "_ this shin- _ -ing", 34: "night."},
 "A": {2: "Sure _", 3: "on _ this", 4: "shin- -ing", 5: "night, _", 6: "Kind- -ness must", 7: "watch for _",
       8: "me _", 9: "This", 10: "side the", 11: "ground. _ The", 12: "late year lies down the", 13: "north. All",
       14: "healed,", 15: "all is", 16: "health, all _ is", 17: "health. _ Sum- -mer", 18: "holds the",
       19: "earth. _ Hearts all", 20: "whole.", 22: "Sure on this shin- -ing", 23: "night _ I weep for",
       24: "won- -der wan-", 25: "_ -d'ring _ far a-", 26: "-lone Of", 27: "shad- -ows on", 28: "_ the",
       29: "stars.", 30: "_", 32: "On", 33: "_ this shin- _ -ing", 34: "night."},
 "T": {3: "Sure on this shin- -ing", 4: "night Of star- -made", 5: "shad- -ows round,", 6: "_ Kind-",
       7: "_ -ness must watch for", 8: "me This", 9: "side the", 10: "ground. The", 11: "late year, the",
       12: "late year lies down the", 13: "north. All _ is", 14: "healed,", 15: "all is", 16: "health.",
       17: "_ _ Sum- -mer", 18: "holds the earth.", 19: "Hearts _ all", 20: "whole.",
       21: "Sure on this shin- -ing", 22: "night I weep for", 23: "won- _ -der", 24: "wan-", 25: "_ -d'ring",
       26: "far a-", 27: "-lone Of", 28: "shad- -ows", 29: "_ on the", 30: "stars.", 32: "On",
       33: "_ this shin- _ -ing", 34: "night."},
 "B": {2: "Sure _", 3: "on this", 4: "shin- -ing", 5: "night,", 6: "Kind- -ness must", 7: "watch for",
       8: "me This", 9: "side the", 10: "ground.", 11: "_ The", 12: "late year lies", 13: "down the",
       14: "north. All is", 15: "healed,", 16: "all is", 17: "health, _", 18: "all,", 19: "all", 20: "is",
       21: "whole. Sure", 22: "on this", 23: "shin- -ing", 24: "night", 25: "wan- -d'ring", 26: "far a-",
       27: "-lone Of", 28: "shad- -ows", 29: "on _ the", 30: "stars.", 32: "On", 33: "_ this shin- _ -ing",
       34: "night."},
}

TIME = {1: "3/4", 9: "2/4", 10: "3/4", 17: "4/4", 18: "3/4", 19: "4/4", 20: "3/4"}
NBARS = 34

# ---- parsing ------------------------------------------------------------
PITCH = re.compile(r"^([A-G])(n|#|b)?(\d)$")
def spell(p, carry):
    """written token pitch -> music21 name, honouring the key signature and in-bar accidentals."""
    m = PITCH.match(p); letter, acc, octv = m.groups()
    k = letter + octv
    if acc: carry[k] = {"n": "", "#": "#", "b": "-"}[acc]
    alter = carry.get(k, "-" if letter in "BE" else "")
    return letter + alter + octv

def parse_token(tok, carry):
    fermata = "!" in tok; arp = "@" in tok
    tok = tok.replace("!", "").replace("@", "")
    slur_start = tok.endswith("("); slur_end = ")" in tok
    tok = tok.replace("(", "").replace(")", "")
    tied = tok.endswith("~"); tok = tok.rstrip("~")
    p, d = tok.split("/") if "/" in tok else (tok, "4")
    dots = d.count("."); d = d.rstrip(".")
    dur = duration.Duration(4.0 / int(d)); dur.dots = dots
    if p in ("r", "h"):
        n = note.Rest()
        if p == "h": n.style.hideObjectOnPrint = True
    elif "+" in p: n = chord.Chord([spell(q, carry) for q in p.split("+")])
    else: n = note.Note(spell(p, carry))
    n.duration = dur
    if fermata: n.expressions.append(expressions.Fermata())
    if arp: n.expressions.append(expressions.ArpeggioMark())
    return n, tied, slur_start, slur_end

def add_lyric(n, syl):
    if syl == "_": return
    syllabic, txt = "single", syl
    if syl.startswith("-") and syl.endswith("-") and len(syl) > 2: syllabic, txt = "middle", syl[1:-1]
    elif syl.endswith("-"): syllabic, txt = "begin", syl[:-1]
    elif syl.startswith("-"): syllabic, txt = "end", syl[1:]
    n.lyrics.append(note.Lyric(text=txt, number=1, syllabic=syllabic, applyRaw=True))

def fill(container, toks, carry, octave, state, part, lyrics=None):
    """append tokens; state carries ties/slurs across bars for one voice."""
    total = 0.0; li = 0
    for tok in toks:
        n, tied, ss, se = parse_token(tok, carry)
        if octave and not n.isRest: n = n.transpose(12 * octave)
        total += n.duration.quarterLength
        if not n.isRest:
            if lyrics is not None and li < len(lyrics): add_lyric(n, lyrics[li])
            li += 1
            if state.get("tied"):
                n.tie = tie.Tie("continue" if tied else "stop"); state["tied"] = False
            if tied:
                if n.tie is None: n.tie = tie.Tie("start")
                state["tied"] = True
            if ss: state["slur"] = n
            if se and state.get("slur") is not None:
                part.insert(0, spanner.Slur(state["slur"], n)); state["slur"] = None
        container.append(n)
    if lyrics is not None and li != len(lyrics):
        raise SystemExit(f"{part.partName} bar {container.number if hasattr(container, 'number') else '?'}: "
                         f"{li} notes vs {len(lyrics)} syllables {lyrics}")
    return total

def bar_len(b):
    ts = [t for k, t in sorted(TIME.items()) if k <= b][-1]
    num, den = map(int, ts.split("/")); return num * 4.0 / den

def header(m, b, clf):
    if b == 1: m.insert(0, clf); m.insert(0, key.KeySignature(-2))
    if b in TIME:
        ts = meter.TimeSignature(TIME[b])
        if TIME[b] == "4/4": ts.symbol = "common"  # printed as C
        m.insert(0, ts)

def build_voice(name, abbr, bars, lyr, clf, octave=0):
    p = stream.Part(); p.partName = name; p.partAbbreviation = abbr
    p.insert(0, instrument.Vocalist()); state = {}
    for b in range(1, NBARS + 1):
        m = stream.Measure(number=b); header(m, b, clf)
        syl = lyr.get(b, "").split()
        got = fill(m, bars[b].split(), {}, octave, state, p, syl if b in lyr else [])
        if got != bar_len(b): raise SystemExit(f"{name} bar {b}: {got} beats, want {bar_len(b)}")
        p.append(m)
    return p

def build_piano_staff(name, bars, clf):
    st = stream.PartStaff(); st.partName = name; states = [{}, {}]
    for b in range(1, NBARS + 1):
        m = stream.Measure(number=b); header(m, b, clf); carry = {}
        layers = bars.get(b, "h/" + {3.0: "2.", 2.0: "2", 4.0: "1"}[bar_len(b)]).split("||")
        if len(layers) == 1:
            got = fill(m, layers[0].split(), carry, 0, states[0], st)
            if got != bar_len(b): raise SystemExit(f"{name} bar {b}: {got} beats")
        else:
            for vi, lay in enumerate(layers):
                v = stream.Voice(id=vi + 1)
                got = fill(v, lay.split(), carry, 0, states[vi], st)
                if got != bar_len(b): raise SystemExit(f"{name} bar {b} v{vi + 1}: {got} beats")
                m.insert(0, v)
        st.append(m)
    return st

# TTBB=1: men's-choir copy in the same key, Barber's four lines kept note for note.
#   Tenor 1 = tenor (the descant half of the canon), Tenor 2 = soprano 8vb (the tune), Bass = bass,
#   Baritone = alto, each note dropped an octave or left at pitch -- chosen per phrase (baritone_line)
#   to stay in range, avoid going under the bass and avoid leaps. Pitch classes never change.
def sounding(bars, octave=0):
    """[(start, end, midi)] for every note of a voice, in crotchets from the top."""
    out = []; t0 = 0.0
    for b in range(1, NBARS + 1):
        carry = {}; t = t0
        for tok in bars[b].split():
            n, *_ = parse_token(tok, carry)
            if not n.isRest: out.append((t, t + n.quarterLength, n.pitch.midi + 12 * octave))
            t += n.quarterLength
        t0 += bar_len(b)
    return out

def baritone_line():
    """alto tokens with each note's octave picked by a Viterbi pass; returns {bar: tokens}."""
    bass, tune = sounding(B), sounding(S, -1)
    over = lambda ev, a, z: [m for s, e, m in ev if s < z and a < e]
    toks = []; t0 = 0.0  # (bar, idx, tok, start, end, midi, tied, is_rest)
    for b in range(1, NBARS + 1):
        carry = {}; t = t0
        for i, tok in enumerate(A[b].split()):
            n, tied, *_ = parse_token(tok, carry); d = n.quarterLength
            toks.append((b, i, tok, t, t + d, None if n.isRest else n.pitch, tied)); t += d
        t0 += bar_len(b)
    notes = [x for x in toks if x[5] is not None]
    def cost(x, o):
        m = x[5].midi + 12 * o; c = 0
        c += 3 * max(0, m - 64) + 3 * max(0, 45 - m)        # baritone range A2..E4
        lo = over(bass, x[3], x[4]); c += 10 if lo and m < min(lo) else 0  # under the bass: inverts the chord
        hi = over(tune, x[3], x[4]); c += 2 if hi and m > max(hi) else 0  # over the tune
        return c
    opts = (-1, 0); best = [{o: (cost(notes[0], o), [o]) for o in opts}]
    for k in range(1, len(notes)):
        prev, x = notes[k - 1], notes[k]; row = {}
        for o in opts:
            def step(po):
                leap = abs(x[5].midi + 12 * o - prev[5].midi - 12 * po)
                return best[-1][po][0] + max(0, leap - 5) + (100 if prev[6] and o != po else 0)
            po = min(opts, key=step); row[o] = (step(po) + cost(x, o), best[-1][po][1] + [o])
        best.append(row)
    octs = dict(zip(((x[0], x[1]) for x in notes), min(best[-1].values())[1]))
    out = {}
    for b in range(1, NBARS + 1):
        line = []
        for (bb, i, tok, s, e, p, tied) in toks:
            if bb != b: continue
            if p is None: line.append(tok); continue
            q = p.transpose(12 * octs[(b, i)])  # explicit accidental on every note: in-bar carries stay right
            acc = {"sharp": "#", "flat": "b"}.get(q.accidental.name if q.accidental else None, "n")
            line.append(re.sub(r"^[A-G][nb#]?\d", q.step + acc + str(q.octave), tok))
        out[b] = " ".join(line)
    return out

# Where the tune climbs (T2 up to G4 in 13) the tenors trade lines: Tenor 1 takes the soprano line and
# Tenor 2 the tenor line between these points ((bar, offset) from -> to). Both lines are on treble-8vb.
TENOR_SWAPS = [((10, 2), (25, 2)), ((27, 0), (29, 1))]
# at the joins the two lines' words don't meet: (part, bar) -> (tokens, lyrics). Only ties, slurs and
# syllables change -- no pitch or duration does.
TENOR_FIXES = {
 ("T1", 24): ("B4/8( A4/8) C5/2", "won- _ -der"),        # untie: re-strike C5 on "wan-" so the word isn't lost
 ("T1", 25): ("C5/4 r/4 B4/4", "wan- -d'ring"),
 ("T2", 25): ("G4/2( D5/4~", "_ _"),                      # "wan-" already sung on G4: slur it on to D5
 ("T2", 26): ("D5/4) C5/8( D5/8) B4/8 A4/8", "_ -d'ring _ far a-"),
 ("T1", 29): ("F4/4( G4/4) G4/4", "_ _ the"),             # "on" already sung on F4: slur it on to G4
 ("T2", 28): ("G4/4 G4/2", "shad- -ows"),                 # untie: re-strike G4 on "on" so the word isn't lost
 ("T2", 29): ("G4/4 G4/2", "on the"),
}

if os.environ.get("NOSWAP") == "1":  # the TTBB copy before the trade: Tenor 1 = tenor, Tenor 2 = soprano throughout
    TENOR_SWAPS, TENOR_FIXES = [], {}

def swapped(b, off):
    return any(a <= (b, off) < z for a, z in TENOR_SWAPS)

def split_bar(toks, syls, off):
    """tokens and syllables before / after offset off (a token boundary)."""
    carry = {}; t = 0.0; k = 0; si = 0
    for k, tok in enumerate(toks + [None]):
        if t >= off - 1e-9: break
        n, *_ = parse_token(tok, carry); t += n.quarterLength; si += 0 if n.isRest else 1
    if abs(t - off) > 1e-9: raise SystemExit(f"tenor swap at offset {off} falls inside a note: {toks}")
    return toks[:k], toks[k:], syls[:si], syls[si:]

def tenor_lines():
    """(bars, lyrics) for Tenor 1 and Tenor 2: tenor / soprano lines, traded inside TENOR_SWAPS."""
    out = {"T1": ({}, {}), "T2": ({}, {})}
    for b in range(1, NBARS + 1):
        cuts = sorted({o for a, z in TENOR_SWAPS for (bb, o) in (a, z) if bb == b and o > 0})
        lines = {"T": (T[b].split(), LYR["T"].get(b, "").split()), "S": (S[b].split(), LYR["S"].get(b, "").split())}
        segs = {"T": [], "S": []}  # [(start offset, tokens, syllables)]
        for v, (tk, sy) in lines.items():
            start = 0.0
            for c in cuts:
                a, tk, sa, sy = split_bar(tk, sy, c - start)
                segs[v].append((start, a, sa)); start = c
            segs[v].append((start, tk, sy))
        for part, home, away in (("T1", "T", "S"), ("T2", "S", "T")):
            tk, sy = [], []
            for i, (start, *_) in enumerate(segs[home]):
                _, t_, s_ = segs[away if swapped(b, start) else home][i]; tk += t_; sy += s_
            out[part][0][b] = " ".join(tk)
            if b in LYR["T"] or b in LYR["S"]: out[part][1][b] = " ".join(sy)
    for (part, b), (tk, ly) in TENOR_FIXES.items():
        bare = lambda x: re.sub(r"[~()]", "", x)
        assert bare(out[part][0][b]) == bare(tk), (part, b, out[part][0][b], tk)  # ties and slurs only
        out[part][0][b] = tk; out[part][1][b] = ly
    return out

TTBB = os.environ.get("TTBB") == "1"
if TTBB:
    BAR = baritone_line()
    TEN = tenor_lines()
    parts = [build_voice("Tenor 1", "T1", *TEN["T1"], clef.Treble8vbClef(), octave=-1),
             build_voice("Tenor 2", "T2", *TEN["T2"], clef.Treble8vbClef(), octave=-1),
             build_voice("Baritone", "Bar", BAR, LYR["A"], clef.BassClef()),
             build_voice("Bass", "B", B, LYR["B"], clef.BassClef())]
else:
    parts = [build_voice("Soprano", "S", S, LYR["S"], clef.TrebleClef()),
             build_voice("Alto", "A", A, LYR["A"], clef.TrebleClef()),
             build_voice("Tenor", "T", T, LYR["T"], clef.Treble8vbClef(), octave=-1),
             build_voice("Bass", "B", B, LYR["B"], clef.BassClef())]
rh = build_piano_staff("Piano", RH, clef.TrebleClef()); rh.insert(0, instrument.Piano())
lh = build_piano_staff("", LH, clef.BassClef())

# ---- markings -----------------------------------------------------------
DYN = {  # part index -> {bar: [(offset, mark)]}; plain words become italic expression text
 0: {2: [(0, "mp"), (0, "espr.")], 10: [(2, "mf")], 13: [(0, "più f")], 17: [(1, "p sub.")], 18: [(2.5, "mf")], 19: [(1, "p")],
     22: [(0, "mf"), (0, "espr.")], 25: [(2, "p")], 27: [(0, "dim. poco a poco")], 32: [(1, "pp")]},
 1: {2: [(0, "p")], 11: [(2, "mf"), (2, "espr.")], 13: [(0, "più f")], 17: [(0, "p sub.")], 18: [(2.5, "mf")], 19: [(0, "p")], 22: [(0, "mf")], 24: [(2, "p"), (2, "espr.")],
     27: [(0, "p sempre marc.")], 32: [(1, "pp")]},
 4: {1: [(0, "p"), (0, "molto legato")], 12: [(0, "mf")], 13: [(0, "più f")], 17: [(0, "p sub.")], 18: [(2.5, "mf")], 19: [(0, "p")],
     21: [(0, "mf")], 27: [(0, "dim. poco a poco")], 32: [(1, "pp")], 31: [(2.5, "mf")], 33: [(0, "morendo e rall.")]},
 2: {3: [(0, "mp"), (0, "espr.")], 11: [(2, "mf")], 13: [(0, "più f")], 17: [(0, "p sub.")], 18: [(2.5, "mf")], 19: [(0, "p")], 21: [(0, "mf"), (0, "espr.")], 25: [(0, "p")],
     26: [(0, "pp")], 27: [(0, "dim. poco a poco")], 32: [(1, "pp")]},
 3: {2: [(0, "p")], 11: [(2, "mf")], 13: [(0, "più f")], 17: [(0, "p sub.")], 18: [(2.5, "mf")], 19: [(0, "p")], 21: [(0, "mf")], 25: [(0, "p")],
     27: [(0, "dim. poco a poco")], 32: [(1, "pp")]},
}
DYN_MARKS = {"p", "pp", "mp", "mf", "f"}
SLOT = {0: 1, 1: 2, 2: 0, 3: 3, 4: 4} if TTBB else {i: i for i in range(5)}  # DYN index (S A T B RH) -> staff
def slot(pi, b, off):
    """staff for DYN index pi at (b, off): in TTBB the S and T marks follow their line across tenor swaps."""
    if TTBB and pi in (0, 2) and swapped(b, off): return {0: 0, 2: 1}[pi]
    return SLOT[pi]
for pi, marks in DYN.items():  # 4 = piano RH (marks sit between the piano staves)
    for b, lst in marks.items():
        for off, txt in lst:
            ms = {m.number: m for m in (parts + [rh])[slot(pi, b, off)].getElementsByClass(stream.Measure)}
            el = dynamics.Dynamic(txt) if txt in DYN_MARKS else expressions.TextExpression(txt)
            if isinstance(el, expressions.TextExpression): el.style.fontStyle = "italic"
            if pi == 4: el.placement = "below"
            ms[b].insert(off, el)
if TTBB:  # at a swap a tenor can pick up the same dynamic twice in one bar (one from each line): drop the repeat
    for p in parts[:2]:
        last = None
        for d in sorted(p.recurse().getElementsByClass(dynamics.Dynamic), key=lambda d: d.getOffsetInHierarchy(p)):
            if (d.measureNumber, d.value) == last: d.activeSite.remove(d)
            last = (d.measureNumber, d.value)
# hairpins off the scan: (bar, offset) -> (bar, offset), "<" or ">", per DYN index
WEDGES = {
 0: [((12, 1.5), (13, 0), "<"), ((15, 0), (16, 0), "<"), ((18, 0), (18, 2.5), "<"), ((19, 1), (19, 3.5), "<"),
     ((20, 0), (21, 0), ">"), ((24, 0), (24, 2), ">"), ((28, 0), (28, 2), "<"), ((29, 0), (30, 0), ">"), ((33, 2), (34, 0), ">")],
 1: [((11, 0), (11, 2), "<"), ((12, 1), (13, 0), "<"), ((15, 0), (16, 0), "<"), ((18, 0), (18, 2.5), "<"), ((19, 2), (19, 3.5), "<"),
     ((20, 0), (21, 0), ">"), ((24, 0), (24, 2), ">"), ((26, 0), (27, 0), ">"), ((28, 0), (28, 2), "<"), ((29, 0), (30, 0), ">"),
     ((33, 2), (34, 0), ">")],
 2: [((11, 1), (11, 2), "<"), ((12, 1), (13, 0), "<"), ((15, 0), (16, 0), "<"), ((18, 0), (18, 2.5), "<"), ((20, 0), (21, 0), ">"),
     ((24, 0), (25, 0), ">"), ((25, 2), (26, 0), ">"), ((28, 0), (28, 2), "<"), ((29, 0), (30, 0), ">"), ((33, 2), (34, 0), ">")],
 3: [((11, 1), (11, 2), "<"), ((12, 1), (13, 0), "<"), ((15, 0), (16, 0), "<"), ((18, 0), (18, 2.5), "<"), ((20, 0), (21, 0), ">"),
     ((24, 0), (25, 0), ">"), ((28, 0), (28, 2), "<"), ((29, 0), (30, 0), ">"), ((33, 2), (34, 0), ">")],
 4: [((10, 1), (12, 0), "<"), ((12, 1), (13, 0), "<"), ((15, 0), (16, 0), "<"), ((18, 0), (18, 2.5), "<"), ((19, 0), (19, 3.5), "<"),
     ((20, 0), (21, 0), ">"), ((31, 0), (31, 2.5), "<"), ((33, 2), (34, 0), ">")],
}
# playback only (hidden): the print leaves the piano at mf from bar 21 and says "dim. poco a poco" at 27;
# without these MuseScore plays it at mf under a p/pp choir until bar 32
PNO_HIDDEN = [(25, 0, "p"), (30, 0, "pp")]
PNO_HIDDEN_WEDGES = [((27, 0), (30, 0), ">")]

def note_at(st, b, off, last=False):
    """the note (or rest) sounding at bar b offset off; last=True picks the one sounding just before it."""
    ms = {m.number: m for m in st.getElementsByClass(stream.Measure)}
    if last and off == 0: b, off = b - 1, bar_len(b - 1)
    els = [n for n in ms[b].recurse().notesAndRests if not n.style.hideObjectOnPrint]
    at_ = lambda n: n.getOffsetInHierarchy(ms[b])
    hit = [n for n in els if (at_(n) < off <= at_(n) + n.quarterLength if last else at_(n) <= off < at_(n) + n.quarterLength)]
    return min(hit, key=at_) if not last else max(hit, key=at_)

def wedge(st, a, z, kind, hidden=False):
    w = (dynamics.Crescendo if kind == "<" else dynamics.Diminuendo)(note_at(st, *a), note_at(st, *z, last=True))
    if hidden: w.style.hideObjectOnPrint = True
    st.insert(0, w)

for pi, ws in WEDGES.items():
    for a, z, kind in ws: wedge((parts + [rh])[slot(pi, *a)], a, z, kind)
rms = {m.number: m for m in rh.getElementsByClass(stream.Measure)}
for b, off, mark in PNO_HIDDEN:
    d = dynamics.Dynamic(mark); d.style.hideObjectOnPrint = True; d.placement = "below"; rms[b].insert(off, d)
for a, z, kind in PNO_HIDDEN_WEDGES: wedge(rh, a, z, kind, hidden=True)
s_ms = {m.number: m for m in parts[0].getElementsByClass(stream.Measure)}
s_ms[1].insert(0, tempo.MetronomeMark(text="Andante", number=50, referent=note.Note(type="quarter")))
for b, off, txt in ((19, 2, "rit."), (21, 0, "a tempo"), (29, 0, "rall."), (30, 0, "a tempo"), (33, 0, "morendo e rall.")):
    s_ms[b].insert(off, tempo.TempoText(txt))

all_parts = parts + [rh, lh]
for p in all_parts:
    ms = {m.number: m for m in p.getElementsByClass(stream.Measure)}
    ms[NBARS].rightBarline = bar.Barline("final")

# LAYOUT: match the scan. p1 1-3|4-6, p2 7-9|10-12, p3 13-16|17-19, p4 20-22|23-26, p5 27-30|31-34
PAGE_STARTS = (7, 13, 20, 27)
SYSTEM_STARTS = (4, 10, 17, 23, 31)
for p in all_parts:
    ms = {m.number: m for m in p.getElementsByClass(stream.Measure)}
    for b in PAGE_STARTS: ms[b].insert(0, layout.PageLayout(isNew=True))
    for b in SYSTEM_STARTS: ms[b].insert(0, layout.SystemLayout(isNew=True))

sc = stream.Score()
sc.metadata = metadata.Metadata(title="Sure on this Shining Night" + (" (TTBB)" if TTBB else ""), composer="Samuel Barber\nAdapted by the composer")
sc.metadata.lyricist = "James Agee"
for p in parts: sc.insert(0, p)
sc.insert(0, rh); sc.insert(0, lh)
sc.insert(0, layout.StaffGroup([rh, lh], name="Piano", abbreviation="Pno.", symbol="brace"))
sc.insert(0, layout.StaffGroup(parts, symbol="bracket", barTogether=False))
sc.insert(0, layout.ScoreLayout(scalingMillimeters=6.0, scalingTenths=40))
out = "sure_on_this_shining_night" + ("_ttbb" if TTBB else "") + ("_noswap" if TTBB and not TENOR_SWAPS else "") + ".musicxml"
sc.write("musicxml", fp=out)
print("wrote", out)
