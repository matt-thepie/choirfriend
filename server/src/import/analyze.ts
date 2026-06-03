/**
 * AI analysis for the bulk importer.
 *
 * Two very different jobs:
 *
 *   PDFs  — Claude can READ the score. We rasterise the first page and ask it
 *           to extract title / composer / arranger. High signal.
 *
 *   Audio — Claude CANNOT hear the file. All it has to go on is the filename
 *           and the folder it sat in, matched against the choir's existing
 *           pieces. So the audio guess is best-effort; the human confirms by
 *           actually listening (the import UI gives them a player).
 *
 * Model is Haiku 4.5 — plenty for this, and cheap across hundreds of files.
 * The Anthropic client reads ANTHROPIC_API_KEY from the environment.
 */

import Anthropic from '@anthropic-ai/sdk';
import { PDFDocument } from 'pdf-lib';

const MODEL = 'claude-haiku-4-5';

let cached: Anthropic | null = null;
/** Lazily build the client. Throws if the key isn't set so the route can 503. */
export function getAnthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — the importer needs it to analyse files.');
  }
  cached ??= new Anthropic();
  return cached;
}

export function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Pull the first text block out of a response and JSON-parse it. With
 *  output_config.format the first block is guaranteed to be schema-valid JSON. */
function parseJsonResponse<T>(content: Anthropic.Messages.ContentBlock[]): T {
  const text = content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error('no text block in model response');
  return JSON.parse(text.text) as T;
}

// --- PDF -------------------------------------------------------------------

export interface PdfGuess {
  docType: 'score' | 'lyrics';
  title: string;
  composer: string;
  arranger: string;
  confidence: 'high' | 'medium' | 'low';
}

const PDF_SCHEMA = {
  type: 'object',
  properties: {
    docType: {
      type: 'string',
      enum: ['score', 'lyrics'],
      description:
        "'score' if the page shows musical notation (staves, notes). 'lyrics' if it is only words/text — a lyrics or words sheet with no music.",
    },
    title: { type: 'string', description: "The work's title exactly as printed. Empty string if not determinable." },
    composer: {
      type: 'string',
      description:
        'Composer, "Surname, Forename" when clear, else as printed. The lyricist (author of the words) is NOT the composer. May be filled from general knowledge for a well-known work even if not printed (lower the confidence in that case). Empty string if unknown.',
    },
    arranger: { type: 'string', description: 'Arranger or editor ONLY if printed on the page ("arr. ...", "ed. ..."). Never inferred. Empty string if none shown.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Confidence in the title and composer.' },
  },
  required: ['docType', 'title', 'composer', 'arranger', 'confidence'],
  additionalProperties: false,
} as const;

const PDF_SYSTEM = `You read the first page of a choir's PDF and extract bibliographic metadata.

First decide docType:
- 'score' — the page contains musical notation (staves with notes).
- 'lyrics' — the page is only words/text (a lyrics or "words" sheet) with no music.

Conventions on a typical score's first page:
- The TITLE is the large heading, usually centred near the top.
- The COMPOSER is usually at the upper RIGHT ("Music by ...", or just a name).
- The LYRICIST / author of the words is usually at the upper LEFT ("Words by ...", "Text: ...") — this is NOT the composer.
- The ARRANGER or EDITOR appears below the title or near the composer ("arr. ...", "ed. ...").
- Ignore publisher names, catalogue numbers, copyright lines, page numbers, tempo/dynamic markings.

Title: prefer what's printed; the filename is a weak hint. Give it in normal Title Case ("Disco Fever") even if the score prints it in ALL CAPITALS.
Composer: prefer what's printed. If it isn't printed but you confidently recognise the work (e.g. a well-known song or standard), you MAY fill in the composer from general knowledge — but set confidence to 'medium' or 'low' to flag that it wasn't on the page.
Arranger: ONLY if printed. Never guess it from general knowledge — the arrangement is specific to this edition. Leave it empty unless it's on the page.`;

/** Extract the first page of a PDF as a one-page PDF, base64-encoded. */
export async function firstPageBase64(pdfBytes: Uint8Array): Promise<string> {
  const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  if (src.getPageCount() === 0) throw new Error('PDF has no pages');
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(src, [0]);
  out.addPage(page);
  const bytes = await out.save();
  return Buffer.from(bytes).toString('base64');
}

export async function analyzePdf(pdfBytes: Uint8Array, filename: string): Promise<PdfGuess> {
  const pageB64 = await firstPageBase64(pdfBytes);
  const res = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: PDF_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: PDF_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pageB64 } },
          { type: 'text', text: `Filename (weak hint only): ${filename}\nExtract title, composer, arranger, and confidence.` },
        ],
      },
    ],
  });
  return parseJsonResponse<PdfGuess>(res.content);
}

// --- Audio voice parts -----------------------------------------------------

export interface TrackGuess {
  filename: string;
  voicePart: string;
  confidence: 'high' | 'medium' | 'low';
}

const TRACKS_SCHEMA = {
  type: 'object',
  properties: {
    tracks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'The input filename this entry is for (echo it back exactly).' },
          voicePart: {
            type: 'string',
            description:
              'Normalised voice part / label: "Soprano", "Alto 2", "Tenor", "Bass", "Baritone", "Full mix", "Piano", "Backing". Empty string if genuinely unclear.',
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['filename', 'voicePart', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['tracks'],
  additionalProperties: false,
} as const;

const TRACKS_SYSTEM = `You label choir learning-track audio files with their voice part(s), from filenames alone — you can't hear them. All files belong to one song. Use the set together as context (if you see S/A/T/B alongside each other, single letters are parts).

Voice parts use SATB, often a men's TTBB voicing — Tenor 1, Tenor 2, Baritone, Bass:
- ALWAYS keep the divisi number: "T1" = "Tenor 1" (not just "Tenor"); "T2" = "Tenor 2". Likewise S1/S2, A1/A2.
- "Bari" / "B1" = "Baritone".
- A code of voice-part letters means ALL those parts sing TOGETHER on the track (piano/backing under them is implied) — label it by those parts; do NOT default it to "Backing". Single letters map S=Soprano, A=Alto, T=Tenor, B=Bass (a bare "B" is Bass, NOT Baritone): so "TB" = "Tenor & Bass", "SA" = "Soprano & Alto", "TTB" = "Tenor 1 & 2 & Bass". Doubled/lower combos: "TT" = "Tenor 1 & 2", and "BB" / "Bar-B" / "Bar/B" = "Baritone & Bass" (Baritone only comes from "Bar"/"Bari" or a doubled "BB"). The complete ensemble = "Full mix" ("SATB", "TTBB").
- Use the OTHER files in the folder to disambiguate. "BT" especially is ambiguous — it can be "Bass & Tenor" OR a "Backing" track; decide from the surrounding tracks (if the folder already has separate part tracks, a lone "BT" is probably Backing; amongst other voicing codes it's parts), and if it's genuinely unclear leave voicePart EMPTY for the human to confirm by ear.
- A piano accompaniment under the voices is implied — do NOT add "Piano" to a part label ("T1 and piano" = "Tenor 1", "Bar-B and piano" = "Baritone & Bass"). Use "Piano" ONLY for a piano-only track with no voices.
- Use "Backing" ONLY for an accompaniment-only track with no voices — e.g. "accompaniment", or a lone "bt"/"backing" tacked onto the song name ("All That Jazz bt" = Backing, "...BT for TTB" = a backing track for the TTB version = Backing). A standalone voicing code (TB, SATB, TTBB…) is the PARTS, not backing.
- A "solo" track is the solo/soloist line for learning by the soloist — label it "Solo" (or e.g. "Tenor Solo" if a part is named too).

Return exactly one entry per input filename, echoing the filename. Leave voicePart empty only if a name is genuinely too cryptic.`;

/** Guess the voice part of each track in a song from their filenames, in one call. */
export async function analyzeTracks(folder: string, filenames: string[]): Promise<TrackGuess[]> {
  if (filenames.length === 0) return [];
  const res = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: TRACKS_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: TRACKS_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: `Folder (the song): ${folder || '(none)'}\n\nFilenames:\n${filenames.map((f) => `  - ${f}`).join('\n')}`,
      },
    ],
  });
  return parseJsonResponse<{ tracks: TrackGuess[] }>(res.content).tracks ?? [];
}

// --- Assigning detached audio to pieces ------------------------------------

export interface PieceForAssign {
  key: string;
  label: string;
  hints: string[];
}
export interface TrackToAssign {
  id: string;
  filename: string;
  folder: string;
}
export interface Assignment {
  id: string;
  pieceKey: string | null;
}

const ASSIGN_SCHEMA = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The track id, echoed back exactly.' },
          pieceKey: { type: 'string', description: 'Key of the matching piece, or empty string if none plausibly fits.' },
        },
        required: ['id', 'pieceKey'],
        additionalProperties: false,
      },
    },
  },
  required: ['assignments'],
  additionalProperties: false,
} as const;

const ASSIGN_SYSTEM = `You match choir audio learning tracks to the piece (song) they belong to, using only filenames and folders.

Each piece has a key, a label (its folder/title) and some example filenames from it. Each track has a filename and the folder it sat in. Match every track to the piece whose name and example files it most resembles — e.g. "And_All_That_Bari.mp3" or a track in a folder like "All That Jazz Backing" belongs to the "And All That Jazz" piece. Look past abbreviations, voice-part suffixes (S/A/T/B, Bari, Piano…) and minor spelling/spacing differences.

These tracks are detached audio that almost certainly belong to one of the listed pieces, so prefer to assign rather than leave empty. Only use an empty string for pieceKey if a track genuinely resembles none of them. Echo each track id.`;

/** Assign each detached audio track to the piece it most likely belongs to, in one call. */
export async function assignTracks(pieces: PieceForAssign[], tracks: TrackToAssign[]): Promise<Assignment[]> {
  if (tracks.length === 0 || pieces.length === 0) return [];
  const pieceList = pieces
    .map((p) => `  key="${p.key}" label="${p.label}"${p.hints.length ? ` files: ${p.hints.join(', ')}` : ''}`)
    .join('\n');
  const trackList = tracks.map((t) => `  id="${t.id}" file="${t.filename}" folder="${t.folder}"`).join('\n');
  const res = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: ASSIGN_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: ASSIGN_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: `Pieces:\n${pieceList}\n\nDetached audio tracks to assign:\n${trackList}\n\nAssign each track to its piece.`,
      },
    ],
  });
  const valid = new Set(pieces.map((p) => p.key));
  const parsed = parseJsonResponse<{ assignments: { id: string; pieceKey: string }[] }>(res.content);
  return (parsed.assignments ?? []).map((a) => ({ id: a.id, pieceKey: valid.has(a.pieceKey) ? a.pieceKey : null }));
}

// --- Holistic import plan --------------------------------------------------

export interface PlanFileInput {
  id: string;
  path: string;
  kind: 'pdf' | 'audio';
}
export interface PlannedFile {
  id: string;
  voicePart: string;
}
export interface PlannedPiece {
  title: string;
  files: PlannedFile[];
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    pieces: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A clear title for this piece (from the score filename, folder, or track names).' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'A file id from the input — echo it exactly.' },
                voicePart: {
                  type: 'string',
                  description:
                    'For an audio track: its voice part(s). KEEP divisi numbers — "T1"="Tenor 1", "T2"="Tenor 2". A combined track covers several parts — "TT"="Tenor 1 & 2", "BB"/"Bar-B"="Baritone & Bass". The whole set ("TTBB"/"SATB") = "Full mix". Piano under a part is implied — do NOT append it ("T1 and Piano" = "Tenor 1"); use "Piano" only for a piano-only track. Also "Backing". Empty for PDFs or if genuinely cryptic.',
                },
              },
              required: ['id', 'voicePart'],
              additionalProperties: false,
            },
          },
        },
        required: ['title', 'files'],
        additionalProperties: false,
      },
    },
    unplaced: {
      type: 'array',
      items: { type: 'string' },
      description: "Ids of files (usually stray audio) you genuinely can't confidently assign to any piece. The human will place these by hand.",
    },
  },
  required: ['pieces', 'unplaced'],
  additionalProperties: false,
} as const;

const PLAN_SYSTEM = `You organise a choir's uploaded files into pieces (songs). You can't open the files — you only see their paths (folders + filenames) and whether each is a PDF or audio.

Look at the WHOLE set holistically and work out the most sensible grouping. Folders are a strong hint, not a rule — real uploads are messy:
- Files in the SAME folder almost always belong to the SAME piece — keep them together. Don't split one folder across several pieces, and NEVER mark a file "unplaced" when other files in its own folder already form a piece (a "...BT..." or oddly-named track sitting beside a score belongs to that score's piece).
- A piece is usually a sheet-music PDF, sometimes with extra lyrics/words PDFs, plus audio learning tracks (one per voice part, maybe a full mix / piano / backing).
- Audio often lives apart from its score — a "Backing Tracks" folder, odd subfolders, different spellings/abbreviations. Match each track to the piece it clearly belongs to by name.
- Some pieces are audio-only (learning tracks with no sheet music). That's fine — make them their own piece.
- Some PDFs are lyrics-only with no separate score. Still a piece.
- Some folders are gig/setlist folders (e.g. "Upcoming Gigs", a venue or event name) holding stray backing tracks for SEVERAL different songs. That is NOT one piece — put those tracks in "unplaced" (the human will sort them); don't invent a piece for a lone stray track.
- Ignore junk/system files.

Give every piece a clear title, and for every audio track its voice part(s). Voice parts use SATB, often a men's TTBB voicing — Tenor 1, Tenor 2, Baritone, Bass:
- ALWAYS keep the divisi number: "T1" / "...T1..." = "Tenor 1" (not just "Tenor"); "T2" = "Tenor 2". Likewise S1/S2, A1/A2.
- "Bari" / "B1" = "Baritone".
- A single track often covers SEVERAL parts at once — combined letters mean a combined track; label it descriptively: "TT" = "Tenor 1 & 2", "BB" or "Bar-B" or "Bar/B" = "Baritone & Bass", "TB" = "Tenor & Bass".
- The complete set means everyone together: "TTBB" (men's choir) or "SATB" = "Full mix".
- Learning tracks normally have a piano accompaniment under the voice — that's implied, so do NOT add "Piano" to a part label: "T1 and Piano" is just "Tenor 1", "Bar-B and Piano" is "Baritone & Bass". Use "Piano" ONLY for a piano-only track with no voice part.
- "BT" / "Backing" = a backing track.
Leave voicePart empty only if a name is genuinely too cryptic, and empty for PDFs.

Don't force a fit: if a stray audio file genuinely doesn't clearly belong to any piece, put its id in "unplaced" rather than guessing — the human will place it. Every real music file must appear exactly once, either inside one piece or in "unplaced". Echo file ids exactly; ignore junk/system files.`;

/** Hand the whole file tree to the model and let it decide the grouping. */
export async function planImport(files: PlanFileInput[]): Promise<{ pieces: PlannedPiece[]; unplaced: string[] }> {
  if (files.length === 0) return { pieces: [], unplaced: [] };
  const list = files.map((f) => `  id="${f.id}" kind=${f.kind} path="${f.path}"`).join('\n');
  const res = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: PLAN_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: PLAN_SCHEMA } },
    messages: [{ role: 'user', content: `Files (${files.length}):\n${list}\n\nGroup them into pieces.` }],
  });
  const parsed = parseJsonResponse<{ pieces: PlannedPiece[]; unplaced: string[] }>(res.content);
  return { pieces: parsed.pieces ?? [], unplaced: parsed.unplaced ?? [] };
}

// --- Holistic structure plan (folder-level) --------------------------------

export interface StructureFolder {
  path: string;
  count: number;
  samples: string[];
}
export interface StructurePiece {
  title: string;
  folders: string[];
}

const STRUCTURE_SCHEMA = {
  type: 'object',
  properties: {
    pieces: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A clear title for this piece.' },
          folders: {
            type: 'array',
            items: { type: 'string' },
            description: 'The exact folder path(s) that make up this piece — echo them verbatim from the input.',
          },
        },
        required: ['title', 'folders'],
        additionalProperties: false,
      },
    },
    unplacedFolders: {
      type: 'array',
      items: { type: 'string' },
      description: "Exact paths of folders that are NOT one piece (gig/setlist/mixed folders). Their files go to the human to sort.",
    },
  },
  required: ['pieces', 'unplacedFolders'],
  additionalProperties: false,
} as const;

const STRUCTURE_SYSTEM = `You organise a choir's music library by reasoning about its WHOLE folder structure at once. You're given every folder with its file count and a few sample filenames. Decide which folders make up which piece (song).

Think holistically — real libraries are messy and inconsistent, so reason about the structure rather than following rigid rules:
- Usually one folder = one piece (its score PDF, maybe lyrics PDFs, and audio learning tracks).
- A piece can span several folders: a song folder plus a sibling/sub "Backing Tracks", "Audio", "Sheet Music", "Performance Track" etc. — group those together into the one piece.
- An "Old Version" / "alternate" subfolder with its own score is usually a separate piece; merge it only if it's clearly the same arrangement.
- A piece can be audio-only (learning tracks, no score) — still a piece.
- Some folders are NOT a piece: gig / setlist / event / "Upcoming …" folders that hold stray tracks for SEVERAL DIFFERENT songs (you can tell from sample filenames naming different songs). Put these in unplacedFolders — the human sorts their contents — never invent a piece for them.

Give every piece a clear title in normal Title Case (not ALL CAPS). Every input folder must appear exactly ONCE: in some piece's folders, or in unplacedFolders. Echo folder paths exactly.`;

/** Reason about the whole folder tree (compact, one call) → folder→piece grouping. */
export async function planStructure(
  folders: StructureFolder[],
): Promise<{ pieces: StructurePiece[]; unplacedFolders: string[] }> {
  if (folders.length === 0) return { pieces: [], unplacedFolders: [] };
  const list = folders
    .map((f) => `  "${f.path}" — ${f.count} file(s): ${f.samples.join(' | ')}`)
    .join('\n');
  const res = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: 12000,
    system: STRUCTURE_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: STRUCTURE_SCHEMA } },
    messages: [{ role: 'user', content: `Folders (${folders.length}):\n${list}\n\nGroup them into pieces.` }],
  });
  const parsed = parseJsonResponse<{ pieces: StructurePiece[]; unplacedFolders: string[] }>(res.content);
  return { pieces: parsed.pieces ?? [], unplacedFolders: parsed.unplacedFolders ?? [] };
}
