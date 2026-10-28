# Only You TTBB — transcription notes (written pitch; tenors treble-8vb)
Key G, 4/4, q=96. Intro bars 1-4 repeated (:||). Segno at bar 5 (A). Fine bar 20 (:||). B Bridge 21-28. 29-36 then D.S. (Verse 3) al Fine.

## Intro 1-4
T1 b1,b2: B4 C5 D5 B4 (e e e e) B4~ half "Ba da da da___"  (slur last e into half)
T1 b3,b4: C5 B4 G4 D4 (e e e e) D4~ half
T2 b1: B4 B4 C5 B4 e + B4 half?? (CHECK zoom) ; b2: B4 C5 D5 B4 + B4 half; b3,b4: C5 B4 G4 D4 + D4 half (verify)
B1: D3 whole tied b1-2 "Ooh,", D3 whole tied b3-4 "ooh."
B2: chord G2(+G3?) whole tied b1-2, b3-4 (CHECK zoom)

## Verse 5-12
T1 b5: D D D D E D C B (8e, last slurred to b6)  Look-ing from the win-dow a-bove
T1 b6: B(tied) B B B A B A G (8e, last slurred to b7)  it's like a sto-ry of love
T1 b7: G half (tied) G e(tied) E5 D5 D5 (e)  can you hear  (last slur to b8)
T1 b8: D5 half (tied) D5 half  me?
T1 b9: = b5 pitches; Come back on-ly yes-ter-day (dashed slur E~D)
T1 b10: = b6 pitches; (tie) [rest-lyric] mov-ing fur-ther a-way
T2 b5: B B B B C B A G ; b6: G G G G F# G F# E ; b7: E half(tied) E e(tied) C5 B4 B4
T2 b8: B4 dotted-quarter (tied) + C5 B4 sixteenths + A4 half "me?"
T2 b9 = b5, b10 = b6
B1 pattern each bar: 8th-rest e q | 8th-rest e q.  b5: B3 G3 | D4 B3 ; b6 same ; b7: C4 G3 | C4 G3 ; b8: D4 B3 | A3 F#3 ; b9=b5 ; b10=b6
B2 pattern: dq e dq e. b5: G2 G3 F#3 F#3 ; b6: E3 E3 D3 D3 ; b7: C3 C3 C3 C3 ; b8: G(2+3) dq, G e, D3 half ; b9: G(2+3) G F#3 F#3 ; b10 = b6
Lyric verses: 1 Look-ing.. 2 Some-times.. 3 This is.. (see PDF). v2/v3 have an 8th-rest lyric symbol where v1 has "it's" (b6 n2, b10 n2 in v1).

## Simon's changes vs the print (encoded, 28 Oct 2026)
- Intro bars 1-4: T2 hold G (written G4, "ooh") instead of doubling T1; B2 sing the low G only (no G3 divisi). B1 keep D.
- Bar 16/32 T1 "day": D, not C (scan garbled there; learning track has D).
- Bridge 21-24 only: T1 sing the printed T2 line, T2 sing the baritone line up an octave. Bars 25-28 as printed.
- Piano (for rehearsal) is the printed reduction: RH = both tenor lines at sounding pitch, LH = both bass lines; chords where rhythms match, two voices otherwise. Built from the vocal tokens, so it follows Simon's voicing, not the print.

- Bar 20 fermatas are bracketed text "(𝄐)" as printed (last time only); playback does not pause.
- Piano intro (bars 1-4) follows the PRINT, not Simon's voicing: RH tenors in unison, LH G octave + G3 divisi (PT2/PB2 overrides in build_only_you.py).
- Piano reduction is NOT the vocal parts stacked: intro and bridge are hand-set from the print (PT1/PT2/PB2 in build_only_you.py). Bridge 21-24 RH = printed "ba da" line only; 25-28 RH = both tenor lines folded into one line of eighths with the held D4 as a hidden-rest second voice.
- Verified 2026-10-28: all 10 piano systems compared side by side with the scan (cmp-<page>-<y>.png crops).
- Bar 18 (and 34): the "knew" tie carries over the half note AND the first eighth of the bar; "on-ly you" starts on the 2nd eighth (T1 E5, T2 C5, B1 F#3, B2 D3). Was wrongly one note early.
- 28 Oct, later: piano reduction rebuilt bar by bar from the scan (bridge 21-28 was wrong: RH is one beamed line with the held D4 in 26/28 as a stemmed-down 2nd voice). All 10 piano systems checked render-over-scan (cmp_pno.py) and head-diffed (checkpno.py) before handover.

## Stems and beaming (28 Oct)
- Piano LH lower voice (B2 line, figure A onwards) stems down as printed; it had been
  imported into MS voice 3 behind an empty `<voice/>`.
- Piano beams in half-bar groups of four, as printed. Bars 19/35 LH open with two
  flagged quavers: run `fix_jumps.py only_you.mscz only_you_fixed.mscz --flag 6:19,35`.
