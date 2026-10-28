# Transcribing a scanned choral score into MuseScore

Workflow used for *Only You* (TTBB, Maierhofer). It is deliberately **not** OCR:
the computer does the one thing it is reliably better than an eye at (measuring
note-head height against the staff lines), the human/Claude reads rhythm, rests,
ties and lyrics from annotated crops, and the practice MP3s act as a cross-check.

## Setup

```sh
python3 -m venv .venv && .venv/bin/pip install music21 librosa numpy scipy pillow mido
brew install poppler imagemagick            # pdftoppm, magick
# MuseScore 4 CLI: "/Applications/MuseScore 4.app/Contents/MacOS/mscore"
```

## Steps

1. **Render the PDF at 300 dpi** — `pdftoppm -r 300 -png score.pdf pages/p`.
2. **Locate note-heads** —
   `python omr.py pages/p-1.png ann --names T1,T2,B1,B2 --clefs treble,treble,bass,bass`
   * finds the staves on the page automatically (groups of 5 evenly spaced long
     lines), skips piano staves by their smaller spacing (`--min-spacing`),
     fits the slope of each staff so a skewed scan does not shift pitches,
   * prints each staff as pitch names grouped by bar line, e.g.
     `p-1 sys2 T1 (treble): D5 D5 D5 D5 E5 D5 C5 B4 | B4 B4 ...`
   * writes `ann/<page>_sys<N>_<voice>.png`: the staff with the detected pitch
     written above each head — **read rhythm, rests, ties, slurs, hollow
     (half/whole) notes and lyrics from these by eye**; hollow heads are not
     detected (they show up as gaps), zoom with `magick -crop ... -resize 300%`.
   * Pitch names are *written* pitch. Tenor staves with the little 8 under the
     treble clef (often missing on old scores) sound an octave lower. music21
     wants *sounding* pitch, so build those parts with `clef.Treble8vbClef()`
     **and** `octave=-1` (`build_part` transposes the tokens down); forgetting
     the transpose makes the tenors appear an octave too high in MuseScore.
3. **Cross-check with practice MP3s** (if any) —
   `python track.py "T1.mp3" 120 700 > t1.txt` (fmin/fmax in Hz; use 50–300
   for basses). pyin gives reliable pitch *classes* on held notes, hops octaves,
   and misses fast repeated syllables. Beware: practice tracks bleed the piano at
   chord changes, and may be voiced for *your* choir rather than as printed
   (Only You: the T2 track sings the baritone line in bars 21–24).
4. **Encode** the score in the compact token syntax of `build_only_you.py`
   (`D5/8`, `G2+G3/4.`, `C5/8~` tie, `B4/8(`/`)` slur, `r/4` rest; lyrics per
   verse with `Look-`/`-ing`/`-na-` syllable markers) → MusicXML.
   **Always match the scan's layout**: note which bars start each system and
   page and insert `layout.SystemLayout(isNew=True)` / `PageLayout(isNew=True)`
   at those bars (see `PAGE_STARTS` / `SYSTEM_STARTS`). Singers rehearse from
   the paper copy, so bar positions must line up. If a system then overflows,
   shrink the staff: `layout.ScoreLayout(scalingMillimeters=6.0, scalingTenths=40)`
   (spatium 1.5 mm, MuseScore's default is 1.75).
   If the choir sings a different voicing from the printed one (check the
   practice tracks / pencil marks on the scan), encode the choir's voicing.
5. **Convert** — `mscore -o out.mscz out.musicxml`; render `-o out.png` and
   compare with the scan page by page; export `-o out.mid` and compare the
   pitch-class timeline with the MP3 pitch tracks per bar (see the end of this
   session's build for the snippet).
6. **Repeat jumps** — MuseScore's MusicXML import turns *Fine* / *D.S. al Fine*
   / segno into plain staff text, so playback stops early. Run
   `python fix_jumps.py out.mscz out_fixed.mscz`: it rewrites them as real
   `<Marker>`/`<Jump>` objects (which MuseScore 4 reads as children of
   `<Measure>`, not of `<voice>`). Check the MIDI length afterwards.
   The same script also turns the `RESTSYL` lyric placeholder into a rendered
   eighth-rest glyph (`<font face="Leland"/>` + U+E4E6); use that where a verse
   has a rest in the lyric line. Likewise `FERMSYL` / `FERMSYLB` staff-text
   placeholders become bracketed fermatas `(𝄐)` (U+E4C0 above / U+E4C1 below)
   for "last time only" pauses — text, not a real fermata, so no playback
   pause. Chord symbols belong on the piano RH staff.
   These Leland characters survive the MusicXML export, and choirfriend's
   flowing reader gives them a music font (`musicText` in
   `client/src/lib/flowing/engrave.ts`, webfonts in `client/public/fonts`),
   so they read the same in the app as in MuseScore.
7. **Check every piano system against the scan** — a "derived" reduction is a
   hypothesis, not a result. For each page and each system:
   `sips --resampleWidth <scan width> render-N.png`, crop render and scan at the
   same y-offset, `magick render scan -append` and look at the pair. The intro
   and bridge of Only You were NOT the vocal parts stacked, and the LH voices
   came out swapped (rests under the staff, stems wrong) until fix_jumps.py
   re-ordered them. Don't hand over until all systems have been looked at.
8. **Hand over** — alongside the `.mscz` and `.musicxml`, always export a PDF
   (`mscore -o out.pdf out_fixed.mscz`) into the song folder so Matt can check
   it without opening MuseScore.

## Gotchas met on Only You

* Page skew of ~0.3° moved pitches by a step on page 3; per-staff slope fit fixed it.
* Beamed eighths next to lyrics: the ellipse opening (0.22 × 0.32 staff spaces)
  keeps heads and discards stems, beams, text.
* Engraving quirk: bars 16/32 tenors are written e + q + e~(hollow dotted) + e
  = 5½ beats; the practice tracks sing e q e~dotted-q e (4 beats) — encoded that way.
