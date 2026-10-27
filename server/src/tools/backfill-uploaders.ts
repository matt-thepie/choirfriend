/**
 * Fill files.uploaded_by_name for imported audio, so rows read
 * "Shared by <name>" instead of "Shared".
 *
 * ChoirMate's export only names each uploader by an anonymised nickname, so
 * the nickname → display name mapping is supplied as a JSON file kept OUTSIDE
 * this repo (it is personal data), e.g. { "some-nickname": "Jane Smith" }.
 *
 *   node --env-file=../.env src/tools/backfill-uploaders.ts \
 *     <manifest.json> <import-progress.json> <mapping.json> [--dry-run]
 *
 * Only touches files with no signed-in uploader (created_by_user_id IS NULL).
 */
import fs from 'node:fs';
import { db } from '../db/index.ts';

const [manifestPath, progressPath, mappingPath, ...flags] = process.argv.slice(2);
if (!manifestPath || !progressPath || !mappingPath) {
  console.error('usage: backfill-uploaders.ts <manifest.json> <import-progress.json> <mapping.json> [--dry-run]');
  process.exit(1);
}
const dryRun = flags.includes('--dry-run');

interface Manifest {
  songs: Array<{ audios: Array<{ id: string; uploaded_by?: { nickname?: string } | null }> }>;
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8')) as { files: Record<string, number> };
const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')) as Record<string, string>;

const update = db.prepare('UPDATE files SET uploaded_by_name = ? WHERE id = ? AND created_by_user_id IS NULL');
const unmapped = new Map<string, number>();
let set = 0;
let notImported = 0;
for (const song of manifest.songs) {
  for (const a of song.audios) {
    const fileId = progress.files[a.id];
    if (fileId === undefined) {
      notImported++;
      continue;
    }
    const nick = a.uploaded_by?.nickname ?? '(none)';
    const name = mapping[nick]?.trim();
    if (!name) {
      unmapped.set(nick, (unmapped.get(nick) ?? 0) + 1);
      continue;
    }
    if (!dryRun) update.run(name, fileId);
    set++;
  }
}
console.log(`${dryRun ? '[dry run] ' : ''}named ${set} files; ${notImported} manifest entries not imported`);
for (const [nick, n] of unmapped) console.log(`  unmapped nickname ${nick}: ${n} files`);
