/**
 * Collapse exact duplicate files within each piece: same kind, same filename
 * (case-insensitive) and same size. Keeps the lowest id, repoints annotations,
 * deletes the other rows and their stored objects.
 *
 *   node --env-file=../.env src/tools/dedupe-files.ts [--dry-run]
 */
import { db } from '../db/index.ts';
import { deleteObject, isB2Configured } from '../storage/b2.ts';
import { deleteLocalFile } from '../import/storage.ts';

const dryRun = process.argv.includes('--dry-run');

interface Row { id: number; piece_id: number; kind: string; filename: string; size_bytes: number | null; storage: 'b2' | 'local'; storage_key: string; title: string }
const rows = db.prepare(`
  SELECT f.id, f.piece_id, f.kind, f.filename, f.size_bytes, f.storage, f.storage_key, p.title
  FROM files f JOIN pieces p ON p.id = f.piece_id ORDER BY f.piece_id, f.id`).all() as unknown as Row[];

const seen = new Map<string, Row>();
const dups: Array<{ dup: Row; keep: Row }> = [];
for (const r of rows) {
  const k = `${r.piece_id}|${r.kind}|${r.filename.toLowerCase()}|${r.size_bytes ?? -1}`;
  const keep = seen.get(k);
  if (keep) dups.push({ dup: r, keep });
  else seen.set(k, r);
}
for (const { dup, keep } of dups) console.log(`#${dup.piece_id} ${dup.title}: #${dup.id} ${dup.filename} → keep #${keep.id}`);
console.log(`\n${dups.length} duplicate rows${dryRun ? ' (dry run)' : ''}`);
if (dryRun || dups.length === 0) process.exit(0);

const repoint = db.prepare('UPDATE annotations SET file_id = ? WHERE file_id = ?');
const del = db.prepare('DELETE FROM files WHERE id = ?');
db.exec('BEGIN');
try {
  for (const { dup, keep } of dups) { repoint.run(keep.id, dup.id); del.run(dup.id); }
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }
for (const { dup } of dups) {
  try {
    if (dup.storage === 'b2' && isB2Configured()) await deleteObject(dup.storage_key);
    else await deleteLocalFile(dup.storage_key);
  } catch (e) { console.warn(`  ! could not delete ${dup.storage_key}: ${(e as Error).message}`); }
}
console.log('done');
