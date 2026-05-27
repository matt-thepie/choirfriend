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
    kind TEXT NOT NULL CHECK(kind IN ('pdf', 'audio')),
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
`);

// Additive migrations for tables that may have existed before a column was added.
// Existing pieces (the seeded sample, anything created before this change) default
// to is_current = 1, which is the "current repertoire" state. Admins can flip later.
addColumnIfMissing('pieces', 'is_current INTEGER NOT NULL DEFAULT 1');

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
