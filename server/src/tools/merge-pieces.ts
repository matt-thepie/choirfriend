/**
 * Merge one piece into another, then delete the loser.
 *
 *   node --env-file=../.env src/tools/merge-pieces.ts <survivorId> <loserId> [--dry-run]
 *
 * What moves:
 *   - files: a loser file whose kind, filename and size match a survivor file is
 *     a duplicate → its annotations are repointed at the survivor's copy and the
 *     row and B2 object are deleted. Anything else is reparented to the survivor.
 *     The survivor's own exact duplicates (same kind/filename/size) are collapsed
 *     too, keeping the lowest id.
 *   - set list membership: moves to the survivor unless it is already listed.
 *   - is_current: survivor becomes current if either was.
 *   - composer/arranger/notes: filled from the loser only where the survivor is empty.
 */
import { db } from '../db/index.ts';
import { deleteObject, isB2Configured } from '../storage/b2.ts';
import { deleteLocalFile } from '../import/storage.ts';

interface FileRow {
  id: number; piece_id: number; kind: string; filename: string; size_bytes: number | null;
  storage: 'b2' | 'local'; storage_key: string;
}

const [, , aArg, bArg, ...rest] = process.argv;
const survivorId = Number(aArg), loserId = Number(bArg);
const dryRun = rest.includes('--dry-run');
if (!Number.isInteger(survivorId) || !Number.isInteger(loserId) || survivorId === loserId) {
  console.error('usage: merge-pieces.ts <survivorId> <loserId> [--dry-run]');
  process.exit(2);
}

const piece = db.prepare('SELECT * FROM pieces WHERE id = ?');
const survivor = piece.get(survivorId) as Record<string, unknown> | undefined;
const loser = piece.get(loserId) as Record<string, unknown> | undefined;
if (!survivor || !loser) { console.error('piece not found'); process.exit(1); }
console.log(`survivor #${survivorId} "${survivor.title}"  <=  loser #${loserId} "${loser.title}"${dryRun ? '  (dry run)' : ''}`);

const filesOf = db.prepare('SELECT id, piece_id, kind, filename, size_bytes, storage, storage_key FROM files WHERE piece_id = ? ORDER BY id');
const key = (f: FileRow) => `${f.kind}|${f.filename.toLowerCase()}|${f.size_bytes ?? -1}`;

const toDelete: FileRow[] = [];
const kept = new Map<string, FileRow>();
const plan: Array<{ sql: string; args: unknown[] }> = [];

// Collapse survivor-internal duplicates first.
for (const f of filesOf.all(survivorId) as unknown as FileRow[]) {
  const k = key(f);
  const keep = kept.get(k);
  if (keep) {
    console.log(`  dup in survivor: #${f.id} ${f.filename} → keep #${keep.id}`);
    plan.push({ sql: 'UPDATE annotations SET file_id = ? WHERE file_id = ?', args: [keep.id, f.id] });
    toDelete.push(f);
  } else kept.set(k, f);
}
// Then fold in the loser's files.
for (const f of filesOf.all(loserId) as unknown as FileRow[]) {
  const keep = kept.get(key(f));
  if (keep) {
    console.log(`  dup from loser:  #${f.id} ${f.filename} → keep #${keep.id}`);
    plan.push({ sql: 'UPDATE annotations SET file_id = ?, piece_id = ? WHERE file_id = ?', args: [keep.id, survivorId, f.id] });
    toDelete.push(f);
  } else {
    console.log(`  move:            #${f.id} ${f.filename}`);
    plan.push({ sql: 'UPDATE files SET piece_id = ? WHERE id = ?', args: [survivorId, f.id] });
    plan.push({ sql: 'UPDATE annotations SET piece_id = ? WHERE file_id = ?', args: [survivorId, f.id] });
    kept.set(key(f), f);
  }
}

// Set lists.
const lists = db.prepare('SELECT set_list_id, position FROM set_list_items WHERE piece_id = ?').all(loserId) as Array<{ set_list_id: number; position: number }>;
for (const l of lists) {
  const already = db.prepare('SELECT 1 FROM set_list_items WHERE set_list_id = ? AND piece_id = ?').get(l.set_list_id, survivorId);
  if (already) console.log(`  set list ${l.set_list_id}: survivor already listed, dropping loser entry`);
  else {
    console.log(`  set list ${l.set_list_id}: repointing to survivor`);
    plan.push({ sql: 'UPDATE set_list_items SET piece_id = ? WHERE set_list_id = ? AND piece_id = ?', args: [survivorId, l.set_list_id, loserId] });
  }
}

// Metadata.
for (const col of ['composer', 'arranger', 'notes'] as const) {
  if (!survivor[col] && loser[col]) {
    console.log(`  ${col}: "${loser[col]}" from loser`);
    plan.push({ sql: `UPDATE pieces SET ${col} = ? WHERE id = ?`, args: [loser[col], survivorId] });
  }
}
if (!survivor.is_current && loser.is_current) {
  console.log('  is_current: 1 from loser');
  plan.push({ sql: 'UPDATE pieces SET is_current = 1 WHERE id = ?', args: [survivorId] });
}
plan.push({ sql: 'UPDATE pieces SET updated_at = unixepoch() WHERE id = ?', args: [survivorId] });
for (const f of toDelete) plan.push({ sql: 'DELETE FROM files WHERE id = ?', args: [f.id] });
plan.push({ sql: 'DELETE FROM pieces WHERE id = ?', args: [loserId] });

console.log(`\n${plan.length} statements, ${toDelete.length} objects to delete`);
if (dryRun) process.exit(0);

db.exec('BEGIN');
try {
  for (const p of plan) db.prepare(p.sql).run(...(p.args as never[]));
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}
for (const f of toDelete) {
  try {
    if (f.storage === 'b2' && isB2Configured()) await deleteObject(f.storage_key);
    else await deleteLocalFile(f.storage_key);
  } catch (e) {
    console.warn(`  ! could not delete object ${f.storage_key}: ${(e as Error).message}`);
  }
}
console.log('done');
