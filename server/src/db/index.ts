/**
 * SQLite via Node's built-in `node:sqlite`. WAL mode, file-based, no daemon.
 * Schema is applied idempotently on every boot — `CREATE … IF NOT EXISTS`
 * and additive ALTERs. Destructive migrations get a versioned runner once
 * we need one.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config.ts';

const config = getConfig();

// Ensure the parent directory exists. SQLite won't create it for us.
const dbDir = path.dirname(path.resolve(config.databaseFile));
fs.mkdirSync(dbDir, { recursive: true });

export const db = new DatabaseSync(config.databaseFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

/**
 * Add a column if it isn't already present. SQLite can't `ALTER TABLE ADD
 * COLUMN IF NOT EXISTS`, so we inspect PRAGMA table_info first. This keeps
 * the schema additive without a migrations runner — fine until we need a
 * destructive change.
 */
function addColumnIfMissing(table: string, columnDef: string): void {
  const columnName = columnDef.trim().split(/\s+/)[0]!;
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((r) => r.name === columnName)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
}

// --- Schema ----------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT,
    -- JSON-encoded array of role strings from the identity provider.
    roles TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

  CREATE TABLE IF NOT EXISTS pieces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    composer TEXT,
    arranger TEXT,
    notes TEXT,
    -- Current repertoire vs archive. 1 = current (default), 0 = archived.
    -- Choristers see current by default; archive is opt-in.
    is_current INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    piece_id INTEGER NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
    -- 'pdf'    sheet music (always a PDF, rendered in the viewer)
    -- 'audio'  learning tracks
    -- 'lyrics' words / crib sheets in any text-ish format (pdf, docx, rtf, txt…)
    -- 'score'  editable notation (MuseScore .mscz/.mscx, MusicXML) — restricted
    --          to the MD / committee / section admins, see canSeeScores().
    kind TEXT NOT NULL CHECK(kind IN ('pdf', 'audio', 'lyrics', 'score')),
    -- For audio: optional label like "Tenor 1" or "Full mix". For PDFs: usually NULL.
    label TEXT,
    -- 'b2' for Backblaze (key is relative to B2_KEY_PREFIX),
    -- 'local' for repo-local dev assets served from client/public.
    storage TEXT NOT NULL CHECK(storage IN ('b2', 'local')),
    -- The opaque storage key. For 'b2': prepended with B2_KEY_PREFIX at URL time.
    --                       For 'local': a path under client/public (e.g. "sample.pdf").
    storage_key TEXT NOT NULL,
    filename TEXT NOT NULL,
    size_bytes INTEGER,
    mime_type TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_files_piece ON files(piece_id);

  CREATE TABLE IF NOT EXISTS annotations (
    -- UUID generated client-side so optimistic creates round-trip cleanly.
    id TEXT PRIMARY KEY,
    piece_id INTEGER NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
    -- Which file in the piece this annotation lives on. PDFs only for now.
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    -- Creator. Always set, even for shared annotations (for attribution).
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Visibility/edit layer.
    --   'private' — only user_id can read or edit
    --   'shared'  — anyone in the choir can read or edit
    layer TEXT NOT NULL CHECK(layer IN ('private', 'shared')),
    page INTEGER NOT NULL,
    -- Annotation kind: 'ink' for now; 'highlight', 'note', 'marker' later.
    kind TEXT NOT NULL,
    -- Kind-specific payload (JSON). For ink: { color, width, points: [{x,y}] }.
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_annotations_lookup ON annotations(piece_id, file_id, page, layer);
  CREATE INDEX IF NOT EXISTS idx_annotations_user ON annotations(user_id);

  -- Voice parts. Choir-wide list; audio files and members point at one.
  -- Seeded with SGMC's parts on first boot; admins can edit via /api/sections.
  CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Full name shown in dropdowns, e.g. "Tenor 1".
    label TEXT NOT NULL,
    -- Short badge, e.g. "T1".
    badge TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  -- Set lists: an ordered selection of pieces (rehearsal running order, a
  -- concert programme). "All songs" is virtual and never stored.
  CREATE TABLE IF NOT EXISTS set_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS set_list_items (
    set_list_id INTEGER NOT NULL REFERENCES set_lists(id) ON DELETE CASCADE,
    piece_id INTEGER NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (set_list_id, piece_id)
  );
  CREATE INDEX IF NOT EXISTS idx_set_list_items_list ON set_list_items(set_list_id, position);
`);

// Additive migrations for tables that may have existed before a column was added.
// Existing pieces (the seeded sample, anything created before this change) default
// to is_current = 1, which is the "current repertoire" state. Admins can flip later.
addColumnIfMissing('pieces', 'is_current INTEGER NOT NULL DEFAULT 1');

// Attribution for uploads — who added this file. Nullable: the seeded sample
// and anything uploaded before this column existed have no recorded creator.
// No ON DELETE behaviour (SQLite can't add FK constraints via ALTER anyway):
// if a user is removed we keep the orphaned id rather than nulling history.
addColumnIfMissing('files', 'created_by_user_id INTEGER REFERENCES users(id)');

// Voice part an audio file belongs to. NULL for PDFs and for tracks that
// aren't part-specific (full mix, piano-only). Set lists use this to pick one
// track per song for a given section.
addColumnIfMissing('files', 'section_id INTEGER REFERENCES sections(id)');

// The member's own voice part. Drives the default section filter. NULL until
// they pick one from the menu.
addColumnIfMissing('users', 'section_id INTEGER REFERENCES sections(id)');

// Track length, shown under the play button on audio rows. Imported from
// ChoirMate's metadata; measured in the browser for new uploads. NULL = unknown.
addColumnIfMissing('files', 'duration_ms INTEGER');

db.exec(`
  -- Per-section notes from the MD / section leader ("Remarks for tenors 2").
  CREATE TABLE IF NOT EXISTS piece_remarks (
    piece_id INTEGER NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
    section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    updated_by_user_id INTEGER REFERENCES users(id),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (piece_id, section_id)
  );

  -- External links (Spotify / YouTube / Apple Music / other) on a song.
  CREATE TABLE IF NOT EXISTS piece_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    piece_id INTEGER NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('spotify', 'youtube', 'appleMusic', 'other')),
    url TEXT NOT NULL,
    label TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_piece_links_piece ON piece_links(piece_id);

  -- What one member thinks of one song: the three-face confidence rating
  -- (1 sad, 2 neutral, 3 happy; NULL unrated) and their private notes.
  CREATE TABLE IF NOT EXISTS member_piece_state (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    piece_id INTEGER NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
    confidence INTEGER CHECK(confidence IN (1, 2, 3)),
    notes TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, piece_id)
  );
`);

// A set list the MD has pinned as "this week's rehearsal". Shown first on the
// home screen. At most one is meant to be pinned at a time (enforced in code).
addColumnIfMissing('set_lists', 'pinned INTEGER NOT NULL DEFAULT 0');

// files.kind gained 'lyrics' and 'score'. SQLite can't alter a CHECK
// constraint, so a DB created before that change gets its files table rebuilt
// once. Detected from the stored CREATE TABLE text.
{
  const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'files'`).get() as { sql: string }).sql;
  if (!ddl.includes("'lyrics'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE files_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        piece_id INTEGER NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('pdf', 'audio', 'lyrics', 'score')),
        label TEXT,
        storage TEXT NOT NULL CHECK(storage IN ('b2', 'local')),
        storage_key TEXT NOT NULL,
        filename TEXT NOT NULL,
        size_bytes INTEGER,
        mime_type TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        created_by_user_id INTEGER REFERENCES users(id),
        section_id INTEGER REFERENCES sections(id)
      );
      INSERT INTO files_new (id, piece_id, kind, label, storage, storage_key, filename, size_bytes, mime_type, sort_order, created_at, created_by_user_id, section_id)
        SELECT id, piece_id, kind, label, storage, storage_key, filename, size_bytes, mime_type, sort_order, created_at, created_by_user_id, section_id FROM files;
      DROP TABLE files;
      ALTER TABLE files_new RENAME TO files;
      CREATE INDEX IF NOT EXISTS idx_files_piece ON files(piece_id);
      COMMIT;
    `);
    db.exec('PRAGMA foreign_keys = ON');
    console.log('[db] rebuilt files table with lyrics/score kinds');
  }
}

// --- User lookups -----------------------------------------------------------

const getUserSectionStmt = db.prepare(`SELECT section_id FROM users WHERE email = ?`);
const setUserSectionStmt = db.prepare(`UPDATE users SET section_id = ? WHERE id = ?`);

export function getUserSectionIdByEmail(email: string): number | null {
  const row = getUserSectionStmt.get(email) as { section_id: number | null } | undefined;
  return row?.section_id ?? null;
}

export function setUserSectionId(userId: number, sectionId: number | null): void {
  setUserSectionStmt.run(sectionId, userId);
}

// --- User upsert (used by auth middleware) --------------------------------

const upsertStmt = db.prepare(`
  INSERT INTO users (email, display_name, roles, last_seen_at)
  VALUES (?, ?, ?, unixepoch())
  ON CONFLICT(email) DO UPDATE SET
    display_name = excluded.display_name,
    roles = excluded.roles,
    last_seen_at = unixepoch()
  RETURNING id
`);

export interface UpsertUserInput {
  email: string;
  displayName: string;
  roles: string[];
}

export function upsertUserByEmail(input: UpsertUserInput): number {
  const row = upsertStmt.get(input.email, input.displayName, JSON.stringify(input.roles)) as
    | { id: number }
    | undefined;
  if (!row) throw new Error('upsertUserByEmail: no row returned');
  return row.id;
}

// Who shared a file when it came from an import rather than a signed-in
// member (ChoirMate migration); shown as "Shared by <name>".
addColumnIfMissing('files', 'uploaded_by_name TEXT');
// Lyrics are text on the song (ChoirMate's Lyrics panel), not a file bucket.
addColumnIfMissing('pieces', 'lyrics TEXT');

// Every PDF on a song is "Sheet music" (ChoirMate files lyric sheets there
// too); the Lyrics panel is text. Re-file any lyric PDFs from earlier imports.
{
  const r = db.prepare(
    "UPDATE files SET kind = 'pdf' WHERE kind = 'lyrics' AND (mime_type = 'application/pdf' OR lower(filename) LIKE '%.pdf')",
  ).run();
  if (Number(r.changes) > 0) console.log(`[db] re-filed ${r.changes} lyric PDFs as sheet music`);
}
