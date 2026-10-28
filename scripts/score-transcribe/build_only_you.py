"""Build Only You (TTBB, arr. Maierhofer) as MusicXML from a compact text transcription.

Token syntax per bar:  PITCH[/DUR][.][~][(|)]   e.g.  D5/8  G2+G3/4.  C5/8~  B4/8(  r/4
  ~  = tie to next note of same pitch     ( ) = slur start / end
Lyrics: one list per verse per bar, one entry per NOTE (rests skipped); "_" = no syllable.
  "Look-" begins a word, "-ing" ends one, "-na-" is a middle syllable.
"""
import re
from music21 import (stream, note, chord, meter, key, clef, tempo, bar, repeat,
                     expressions, spanner, harmony, metadata, instrument, duration, tie, layout, text)

REST_SYL = "RESTSYL"  # verse 2/3 rest where verse 1 has a syllable; fix_jumps.py swaps in <sym>restEighth</sym>

T1 = {
 1: "B4/8 C5/8 D5/8 B4/8~ B4/2", 2: "B4/8 C5/8 D5/8 B4/8~ B4/2",
 3: "C5/8 B4/8 G4/8 D4/8~ D4/2", 4: "C5/8 B4/8 G4/8 D4/8~ D4/2",
 5: "D5/8 D5/8 D5/8 D5/8 E5/8 D5/8 C5/8 B4/8~", 6: "B4/8 B4/8 B4/8 B4/8 A4/8 B4/8 A4/8 G4/8~",
 7: "G4/2~ G4/8~ E5/8 D5/8 D5/8~", 8: "D5/2 D5/2",
 13: "r/4 E5/8 E5/8 E5/8 E5/8 D5/8 E5/8", 14: "D5/8 C5/4 C5/8~ C5/2",
 15: "r/4 D5/8 D5/8 D5/8 D5/8 C5/8 D5/8", 16: "C5/8 B4/4 D5/8~ D5/4. D5/8",
 17: "E5/4 D5/4 C5/8 B4/4 C5/8~", 18: "C5/2~ C5/8 E5/8 D5/8 B4/8~", 19: "B4/1~", 20: "B4/1",
 # bars 21-24: printed as tacet; the choir sings the printed T2 line here (see VOICING below)
 25: "r/4 B4/8 G4/8 r/4 D5/8 B4/8", 26: "r/8 D4/8 G4/8 B4/8 D5/8 C5/8 B4/8 G4/8",
 27: "r/8 C4/8 E4/8 G4/8 C5/8 G4/8 E4/8 C4/8", 28: "r/8 D4/8 G4/8 B4/8 A4/8 G4/8 F#4/8 D4/8",
}
T2 = {
 1: "G4/1~", 2: "G4/1~", 3: "G4/1~", 4: "G4/1",  # Simon: tenor 2s hold the G ("ooh") instead of the divided basses
 5: "B4/8 B4/8 B4/8 B4/8 C5/8 B4/8 A4/8 G4/8~", 6: "G4/8 G4/8 G4/8 G4/8 F#4/8 G4/8 F#4/8 E4/8~",
 7: "E4/2~ E4/8~ C5/8 B4/8 B4/8~", 8: "B4/4.( C5/16 B4/16) A4/2",
 13: "r/4 C5/8 C5/8 C5/8 C5/8 B4/8 C5/8", 14: "B4/8 A4/4 A4/8~ A4/2",
 15: "r/4 B4/8 B4/8 B4/8 B4/8 A4/8 B4/8", 16: "A4/8 G4/4 G4/8~ G4/4. G4/8",
 17: "C5/4 B4/4 A4/8 G4/4 A4/8~", 18: "A4/2~ A4/8 C5/8 B4/8 G4/8~", 19: "G4/1~", 20: "G4/1",
 21: "B4/8 G4/8 r/4 D5/8 B4/8 r/4", 22: "C5/8 B4/8 G4/8 D4/8~ D4/2",
 23: "C5/8 B4/8 G4/8 E4/8~ E4/8 D4/8 E4/8 G4/8", 24: "C5/8 B4/8 G4/8 D4/8~ D4/2",
}
B1 = {
 1: "D3/1~", 2: "D3/1", 3: "D3/1~", 4: "D3/1",
 5: "r/8 B3/8 G3/4 r/8 D4/8 B3/4", 6: "r/8 B3/8 G3/4 r/8 D4/8 B3/4",
 7: "r/8 C4/8 G3/4 r/8 C4/8 G3/4", 8: "r/8 D4/8 B3/4 r/8 A3/8 F#3/4",
 13: "G3/1(", 14: "F#3/1)", 15: "G3/1(", 16: "B3/2.)~ B3/8 A3/8",
 17: "G3/4 G3/4 G3/8 G3/4 F#3/8~", 18: "F#3/2~ F#3/8 F#3/8 F#3/8 G3/8~",
 19: "G3/8 G3/8 D3/4 r/8 G3/8 D3/4", 20: "r/8 G3/8 D3/4 r/8 G3/8 D3/4",
}
B2 = {
 1: "G2/1~", 2: "G2/1", 3: "G2/1~", 4: "G2/1",  # Simon: low note only
 5: "G2+G3/4. G3/8 F#3/4. F#3/8", 6: "E3/4. E3/8 D3/4. D3/8",
 7: "C3/4. C3/8 C3/4. C3/8", 8: "G2+G3/4. G2+G3/8 D3/2",
 13: "C3/1(", 14: "D3/1)", 15: "G2/1(", 16: "E3/2.)~ E3/8 E3/8",
 17: "C3/4 C3/4 C3/8 C3/4 D3/8~", 18: "D3/2~ D3/8 D3/8 D3/8 G2+D3/8~",
 19: "G2+D3/4. G2+G3/8 G2+G3/2", 20: "G2+G3/4. G2+G3/8 G2+G3/2",
}
# repeated material
for v in (T1, T2, B1, B2):
    for b in range(9, 13): v[b] = v[b - 4]
    for b in range(29, 37): v[b] = v[b - 16]
for b in range(21, 29): B1[b] = B1[b - 16]; B2[b] = B2[b - 16]
# VOICING: the choir (and the practice tracks) swap the bridge: T1 sings the printed T2 line,
# T2 sings the baritone line. Matches the handwritten "T1" / "T2/Br" relabelling on the scan.
def up_octave(bar):  # bass-clef written pitch -> tenor (treble 8vb) written pitch
    return re.sub(r"([A-G][#b]?)(\d)", lambda m: m.group(1) + str(int(m.group(2)) + 1), bar)
# Only bars 21-24 are swapped; 25-28 are sung as printed (T1 has its own line there).
for b in range(25, 29): T2[b] = T2[b - 4]  # printed T2 repeats its 21-24 line
for b in range(21, 25):
    T1[b] = T2[b]
    T2[b] = up_octave(B1[b])

# ---- lyrics -------------------------------------------------------------
BADA4 = ["Ba", "da", "da", "da", "_"]
INTRO = {1: BADA4, 2: ["ba", "da", "da", "da", "_"], 3: ["ba", "da", "da", "da", "_"], 4: ["ba", "da", "da", "da.", "_"]}
VERSE = {  # bars 5-12, three verses, per note (rests skipped)
 5: [["Look-", "-ing", "from", "the", "win-", "-dow", "a-", "-bove"],
     ["Some-", "-times", "when", "I", "think", "of", "your", "name"],
     ["This", "is", "gon-", "-na", "take", "a", "long", "time"]],
 6: [["_", "it's", "like", "a", "sto-", "-ry", "of", "love,"],
     ["_", REST_SYL, "and", "it's", "on-", "-ly", "a", "game,"],
     ["_", REST_SYL, "and", "I", "won-", "-der", "what's", "mine,"]],
 7: [["_", "_", "can", "you", "hear"], ["_", "_", "and", "I", "need"], ["_", "_", "can't", "take", "no"]],
 8: [["_", "me?"], ["_", "you."], ["_", "more."]],
 9: [["Come", "back", "on-", "-ly", "yes-", "_", "-ter-", "-day"],
     ["List'n-", "-ing", "to", "the", "words", "that", "you", "say"],
     ["Won-", "-der", "if", "you'll", "un-", "_", "-der-", "-stand,"]],
 10: [["_", REST_SYL, "mov-", "-ing", "fur-", "-ther", "a-", "-way,"],
      ["_", "it's", "get-", "-ting", "har-", "-der", "to", "stay,"],
      ["_", "it's", "just", "the", "touch", "of", "your", "hand"]],
 11: [["_", "_", "won't", "you", "hear"], ["_", "_", "when", "I", "see"], ["_", "_", "be-", "-hind", "a", "closed"]],
 12: [["_", "me?"], ["_", "you."], ["_", "door."]],
}
VERSE[11][2] = ["_", "_", "be-", "-hind", "a"]  # 'closed' falls on the slurred last note -> handled below
CHORUS = {13: ["1.–3. All", "I", "need-", "-ed", "was", "the"], 14: ["love", "you", "gave,", "_"],
          15: ["all", "I", "need-", "-ed", "for", "an-"], 16: ["-oth-", "-er", "day,", "_", "and"],
          17: ["all", "I", "ev-", "-er", "knew,"], 18: ["_", "_", "on-", "-ly", "you."], 19: ["_"], 20: ["_"]}
CHORUS2 = {b: (["All", "I", "need-", "-ed", "was", "the"] if b == 13 else s) for b, s in CHORUS.items()}

def lyr_T1():
    L = {}
    L.update(INTRO)
    for b in range(5, 13): L[b] = VERSE[b]
    for b in range(13, 21): L[b] = CHORUS[b]
    L[21] = ["Ba", "da", "ba", "da"]; L[22] = ["ba", "da", "da", "da,", "_"]
    L[23] = ["ba", "da", "da", "da", "_", "da", "da", "da"]; L[24] = ["ba", "da", "da", "da.", "_"]
    L[25] = ["Ba", "da", "ba", "da"]
    for b in (26, 27): L[b] = ["ba", "da", "da", "da", "da", "da", "da"]
    L[28] = ["ba", "da", "da", "da", "da", "da", "da."]
    for b in range(29, 37): L[b] = CHORUS2[b - 16]
    return L
def lyr_T2():
    L = lyr_T1()
    L[1] = ["Ooh"]; L[2] = ["_"]; L[3] = ["_"]; L[4] = ["_"]
    L[8] = [["_", "_", "_", "me?"], ["_", "_", "_", "you."], ["_", "_", "_", "more."]]
    L[12] = [["_", "_", "_", "me?"], ["_", "_", "_", "you."], ["_", "_", "_", "door."]]
    for b in range(21, 25):  # baritone line, bars 21-24 only
        L[b] = ["Ba", "da", "ba", "da"] if b == 21 else ["ba", "da", "ba", "da"]
    L[24] = ["Ba", "da", "ba", "da."]
    L[25] = ["Ba", "da", "ba", "da"]; L[26] = ["ba", "da", "da", "da,", "_"]  # printed T2 line, as T1 sang it in 21-24
    L[27] = ["ba", "da", "da", "da", "_", "da", "da", "da"]; L[28] = ["ba", "da", "da", "da.", "_"]
    return L
def lyr_B1():
    L = {1: ["Ooh,"], 2: ["_"], 3: ["ooh."], 4: ["_"]}
    for b in list(range(5, 13)) + list(range(21, 29)):
        L[b] = ["Ba", "da", "ba", "da"] if b in (5, 9, 21, 25) else ["ba", "da", "ba", "da"]
    L[8] = ["ba", "da", "ba", "da."]; L[12] = ["ba", "da", "ba", "da."]; L[24] = ["Ba", "da", "ba", "da."]; L[28] = ["Ba", "da", "ba", "da."]
    L[13] = ["Ooh,"]; L[14] = ["_"]; L[15] = ["ooh,"]; L[16] = ["_", "_", "and"]
    L[17] = ["all", "I", "ev-", "-er", "knew,"]; L[18] = ["_", "_", "on-", "-ly", "you."]
    L[19] = ["_", "Ba", "da", "ba", "da"]; L[20] = ["ba", "da", "ba", "da."]
    for b in range(29, 37): L[b] = L[b - 16]
    return L
def lyr_B2():
    L = {1: ["Ooh,"], 2: ["_"], 3: ["ooh."], 4: ["_"]}
    for b in list(range(5, 13)) + list(range(21, 29)):
        L[b] = ["Doo", "doo", "doo", "doo"] if b in (5, 9, 21, 25) else ["doo"] * 4
    for b in (8, 12, 24, 28): L[b] = ["doo", "doo", "doo."]
    L[13] = ["Ooh,"]; L[14] = ["_"]; L[15] = ["ooh,"]; L[16] = ["_", "_", "and"]
    L[17] = ["all", "I", "ev-", "-er", "knew,"]; L[18] = ["_", "_", "on-", "-ly", "you."]
    L[19] = ["_", "Doo", "doo"]; L[20] = ["doo", "doo", "doo."]
    for b in range(29, 37): L[b] = L[b - 16]
    return L

CHORDS = {1: "G", 2: "G", 3: "G", 4: "G", 5: ["G", "D/F#"], 6: ["Em", "Bm/D"], 7: "C", 8: ["G", "D7"],
          9: ["G", "D/F#"], 10: ["Em", "Bm/D"], 11: "C", 12: ["G", "D"], 13: "C", 14: "D7", 15: "G", 16: "Em7",
          17: "C", 18: "D7", 19: "G", 20: "G", 21: ["G", "D/F#"], 22: ["Em", "G/D"], 23: "C", 24: ["G", "D7"],
          25: ["G", "D/F#"], 26: ["Em", "G/D"], 27: "C", 28: ["G", "D"], 29: "C", 30: "D7", 31: "G", 32: "Em7",
          33: "C", 34: "D7", 35: "G", 36: "G"}

# ---- parsing ------------------------------------------------------------
def parse_token(tok):
    slur_start = tok.endswith("("); slur_end = ")" in tok
    tok = tok.replace("(", "").replace(")", "")
    tied = tok.endswith("~"); tok = tok.rstrip("~")
    if "/" in tok: p, d = tok.split("/")
    else: p, d = tok, "4"
    dots = d.count("."); d = d.rstrip(".")
    dur = duration.Duration(4.0 / int(d)); dur.dots = dots
    if p == "r": n = note.Rest()
    elif "+" in p: n = chord.Chord(p.split("+"))
    else: n = note.Note(p)
    n.duration = dur
    return n, tied, slur_start, slur_end

def add_lyric(n, syl, verse_no):
    if syl == "_" or syl is None: return
    syllabic = "single"
    txt = syl
    if syl.startswith("-") and syl.endswith("-") and len(syl) > 2: syllabic, txt = "middle", syl[1:-1]
    elif syl.endswith("-") and len(syl) > 1: syllabic, txt = "begin", syl[:-1]
    elif syl.startswith("-") and len(syl) > 1: syllabic, txt = "end", syl[1:]
    if txt == REST_SYL: txt = "RESTSYL"  # placeholder; fix_jumps.py swaps in <sym>restEighth</sym>
    n.lyrics.append(note.Lyric(text=txt, number=verse_no, syllabic=syllabic, applyRaw=True))

def build_part(name, abbr, bars, lyrics, clf, chords=None, octave=0):
    """octave=-1 for treble-8vb parts: tokens are written pitches, music21 wants sounding ones."""
    p = stream.Part(); p.partName = name; p.partAbbreviation = abbr
    p.insert(0, instrument.Vocalist())
    pending_slur = None; prev_tied = None
    for b in range(1, 37):
        m = stream.Measure(number=b)
        if b == 1:
            m.insert(0, clf); m.insert(0, key.Key("G")); m.insert(0, meter.TimeSignature("4/4"))
        toks = bars[b].split()
        lyr = lyrics.get(b)
        verses = lyr if (lyr and isinstance(lyr[0], list)) else ([lyr] if lyr else [])
        ni = 0
        for tok in toks:
            n, tied, ss, se = parse_token(tok)
            if octave and not n.isRest: n = n.transpose(12 * octave)
            if not n.isRest:
                for vi, vl in enumerate(verses):
                    if ni < len(vl): add_lyric(n, vl[ni], vi + 1)
                ni += 1
                if prev_tied is not None:
                    n.tie = tie.Tie("stop") if not tied else tie.Tie("continue")
                    prev_tied = None
                if tied:
                    if n.tie is None: n.tie = tie.Tie("start")
                    prev_tied = n
                if ss: pending_slur = n
                if se and pending_slur is not None:
                    p.insert(0, spanner.Slur(pending_slur, n)); pending_slur = None
            m.append(n)
        if chords and b in chords:
            c = chords[b]
            if isinstance(c, list):
                m.insert(0, harmony.ChordSymbol(c[0])); m.insert(2, harmony.ChordSymbol(c[1]))
            else:
                m.insert(0, harmony.ChordSymbol(c))
        p.append(m)
    return p

# ---- piano (rehearsal reduction) ---------------------------------------
# The printed piano is a straight reduction: RH = the two tenor lines (sounding pitch),
# LH = the two bass lines.  Where both lines share a rhythm they are written as chords,
# otherwise as two voices.  Built from the vocal tokens, so it follows the choir's voicing.
def notes_of(bar, octave):
    out = []; prev_tied = False
    for tok in bar.split():
        n, tied, _, _ = parse_token(tok)
        if octave and not n.isRest: n = n.transpose(12 * octave)
        if not n.isRest:
            if prev_tied: n.tie = tie.Tie("continue" if tied else "stop")
            elif tied: n.tie = tie.Tie("start")
        out.append(n); prev_tied = tied and not n.isRest
    return out

def merge_bar(a, b):
    sig = lambda ns: [(n.duration.quarterLength, n.isRest, n.tie.type if n.tie else None) for n in ns]
    if sig(a) != sig(b):
        return None
    out = []
    for x, y in zip(a, b):
        if x.isRest: out.append(x); continue
        ps = list(dict.fromkeys(p.nameWithOctave for p in list(x.pitches) + list(y.pitches)))
        c = chord.Chord(ps); c.duration = x.duration; c.tie = x.tie
        out.append(c)
    return out

def build_staff(name, upper, lower, clf, octave=0, chords=None, hide_lower_rests=False):
    st = stream.PartStaff(); st.partName = name
    for b in range(1, 37):
        m = stream.Measure(number=b)
        if b == 1:
            m.insert(0, clf); m.insert(0, key.Key("G")); m.insert(0, meter.TimeSignature("4/4"))
        a, c = notes_of(upper[b], octave), notes_of(lower[b], octave)
        merged = merge_bar(a, c)
        if merged is not None:
            for n in merged: m.append(n)
        else:
            for vid, ns in ((1, a), (2, c)):
                v = stream.Voice(id=vid)
                for n in ns:
                    if vid == 2 and hide_lower_rests and n.isRest: n.style.hideObjectOnPrint = True
                    v.append(n)
                m.insert(0, v)
        if chords and b in chords:  # chord symbols sit above the piano RH, as in the print
            c = chords[b]
            if isinstance(c, list):
                m.insert(0, harmony.ChordSymbol(c[0])); m.insert(2, harmony.ChordSymbol(c[1]))
            else:
                m.insert(0, harmony.ChordSymbol(c))
        st.append(m)
    return st

# Piano follows the PRINT, not Simon's voicing. Every bar below was read off the scan at 3x
# (scratchpad pno/p4s2*.png) and compared render-over-scan before handover:
#  - intro: RH = tenors in unison, LH = G octave + the G3 divisi
#  - 21-24: RH = the printed T2 "ba da" line only (the baritone line is in the LH already)
#  - 25-28: one beamed RH line; in 26 and 28 the D4 on the 4th eighth is tied into a
#    stem-down half note = second voice (rests hidden), exactly as printed
PT1 = {**T1,  # bars 21-24: T1 already holds the printed T2 "ba da" line after the choir-voicing swap
       25: "B4/8 G4/8 B4/8 G4/8 D5/8 B4/8 D5/8 B4/8",
       26: "C5/8 B4+D4/8 G4/8 B4/8 D5/8 C5/8 B4/8 G4/8",
       27: "C5/8 B4+C4/8 G4+E4/8 E4+G4/8 C5+E4/8 G4+D4/8 E4/8 C4+G4/8",
       28: "C5/8 B4+D4/8 G4/8 D4/8 A4/8 G4/8 F#4/8 D4/8"}
PT2 = {**T2, **{b: PT1[b] for b in (1, 2, 3, 4, 21, 22, 23, 24, 25, 27)},
       26: "r/8 r/8 r/8 D4/8~ D4/2", 28: "r/8 r/8 r/8 D4/8~ D4/2"}
PB2 = {**B2, 1: "G2+G3/1~", 2: "G2+G3/1", 3: "G2+G3/1~", 4: "G2+G3/1"}
rh = build_staff("Piano (for rehearsal)", PT1, PT2, clef.TrebleClef(), octave=0, chords=CHORDS, hide_lower_rests=True)  # print writes RH at tenor written pitch, not sounding
lh = build_staff("", B1, PB2, clef.BassClef())
rh.insert(0, instrument.Piano())

s = stream.Score()
s.metadata = metadata.Metadata(title="Only You", composer="Music & Words: Vincent Clarke\nArr. Lorenz Maierhofer, nach Soren Sigurd Barret")
parts = [build_part("Tenor 1", "T1", T1, lyr_T1(), clef.Treble8vbClef(), octave=-1),
         build_part("Tenor 2", "T2", T2, lyr_T2(), clef.Treble8vbClef(), octave=-1),
         build_part("Bass 1", "B1", B1, lyr_B1(), clef.BassClef()),
         build_part("Bass 2", "B2", B2, lyr_B2(), clef.BassClef())]
for p in parts: s.insert(0, p)
s.insert(0, rh); s.insert(0, lh); s.insert(0, layout.StaffGroup([rh, lh], name="Piano", abbreviation="Pno.", symbol="brace"))
parts = parts + [rh, lh]

# structure: intro repeat, segno + A at 5, Fine + repeat at 20, B at 21, D.S. al Fine at 36, fermatas at 20
for pi, p in enumerate(parts):
    ms = {m.number: m for m in p.getElementsByClass(stream.Measure)}
    ms[4].rightBarline = bar.Repeat(direction="end")
    ms[5].leftBarline = bar.Repeat(direction="start")
    ms[20].rightBarline = bar.Repeat(direction="end")
    ms[36].rightBarline = bar.Barline("final")
    top = ms[20].voices[0] if ms[20].voices else ms[20]  # first voice only, so the fermata sits above the staff
    last = [n for n in top.notesAndRests][-1]
    # the scan brackets the fermatas "(fermata)" = last time only. MuseScore has no bracketed fermata,
    # so write it as text (placeholder swapped for the Leland glyph in fix_jumps.py). No playback pause.
    fs = expressions.TextExpression("FERMSYLB" if p is parts[-1] else "FERMSYL")
    fs.placement = "below" if p is parts[-1] else "above"  # piano LH gets the inverted one under the staff
    ms[20].insert(last.offset, fs)
    if pi == 0:
        ms[1].insert(0, tempo.TempoText("Intro, freely"))
        ms[5].insert(0, tempo.MetronomeMark(number=96, referent=note.Note(type="quarter")))
        ms[5].insert(0, repeat.Segno())
        ms[5].insert(0, expressions.RehearsalMark("A"))
        ms[20].insert(4, repeat.Fine())
        ms[21].insert(0, expressions.RehearsalMark("B"))
        ms[21].insert(0, expressions.TextExpression("Bridge"))
        ms[36].insert(4, repeat.DalSegnoAlFine())
#        ms[36].insert(0, expressions.TextExpression("(D.S. = Verse 3)"))

# LAYOUT: match the scan's systems and pages so rehearsal references line up.
# scan: p1 = 1-4 | 5-7, p2 = 8-10 | 11-13, p3 = 14-16 | 17-20, p4 = 21-24 | 25-28, p5 = 29-32 | 33-36
PAGE_STARTS = (8, 14, 21, 29)
SYSTEM_STARTS = (5, 11, 17, 25, 33)
for p in parts:
    ms = {m.number: m for m in p.getElementsByClass(stream.Measure)}
    for b in PAGE_STARTS: ms[b].insert(0, layout.PageLayout(isNew=True))
    for b in SYSTEM_STARTS: ms[b].insert(0, layout.SystemLayout(isNew=True))

# smaller staff size (spatium 1.5 mm, MuseScore default 1.75) so the scan's 3-bar lyric systems fit a page
s.insert(0, layout.ScoreLayout(scalingMillimeters=6.0, scalingTenths=40))
s.write("musicxml", fp="only_you.musicxml")
# post-process: give the jumps <sound> attributes so MuseScore/MIDI honour them
x = open("only_you.musicxml", encoding="utf-8").read()
x = x.replace('<segno default-y="20" />\n        </direction-type>', '<segno default-y="20" />\n        </direction-type>\n        <sound segno="segno1" />')
x = x.replace('<words default-y="20" justify="right">fine</words>\n        </direction-type>', '<words default-y="20" justify="right">Fine</words>\n        </direction-type>\n        <sound fine="yes" />')
x = x.replace('<words default-y="20" justify="right">Dal Segno al fine</words>\n        </direction-type>', '<words default-y="20" justify="right">D.S. al Fine</words>\n        </direction-type>\n        <sound dalsegno="segno1" />')
open("only_you.musicxml", "w", encoding="utf-8").write(x)
print("wrote only_you.musicxml")
