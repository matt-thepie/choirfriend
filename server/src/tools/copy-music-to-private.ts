/**
 * Copy the music (everything under pieces/) from the public bucket into the
 * private music bucket. Part of moving to a private bucket; see
 * docs/private-music-runbook.md.
 *
 *   cd server
 *   node --env-file=../.env src/tools/copy-music-to-private.ts            # dry run: lists what would be copied
 *   node --env-file=../.env src/tools/copy-music-to-private.ts --execute  # copies
 *
 * Needs B2_MUSIC_BUCKET (and its key, if different) in .env alongside the
 * existing B2_* values. It reads from the public bucket with the existing
 * key and writes to the music bucket with the music key, so neither key
 * needs access to both buckets.
 *
 * It never deletes or changes anything in the public bucket, and never
 * overwrites an object already in the music bucket with the same size. Run
 * it as often as you like: a second run copies only what is new.
 *
 * Cover pictures (images/) are deliberately left alone: they stay public.
 *
 * It finishes by checking every file the database knows about against the
 * music bucket, and exits non-zero if any is missing.
 */

import { db } from '../db/index.ts';
import { getConfig } from '../config.ts';
import { copyBetweenStores, isB2Configured, listObjects } from '../storage/b2.ts';

/** The only folder that holds music. */
const MUSIC_FOLDER = 'pieces/';

export interface CopyReport {
  /** Objects under pieces/ in the public bucket. */
  inPublic: number;
  /** Already in the music bucket with the same size. */
  alreadyThere: number;
  /** Copied this run (or, in a dry run, that would be). */
  copied: string[];
  failed: Array<{ key: string; error: string }>;
  /** Files and flowing scores in the database with no object in the music
   *  bucket (after this run; in a dry run, counting what would be copied). */
  missingFromMusic: string[];
}

function databaseKeys(): string[] {
  const files = db.prepare(`SELECT storage_key AS k FROM files WHERE storage = 'b2'`).all() as Array<{ k: string }>;
  const renditions = db
    .prepare(`SELECT storage_key AS k FROM score_renditions WHERE storage = 'b2' AND storage_key IS NOT NULL`)
    .all() as Array<{ k: string }>;
  return [...new Set([...files, ...renditions].map((r) => r.k))];
}

export async function copyMusicToPrivate(opts: { execute: boolean; log?: (line: string) => void }): Promise<CopyReport> {
  const log = opts.log ?? (() => undefined);
  const { b2 } = getConfig();
  if (!isB2Configured()) throw new Error('B2 is not configured (B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT, B2_REGION).');
  if (!b2.music) throw new Error('B2_MUSIC_BUCKET is not set, so there is no private bucket to copy into.');
  if (b2.music.bucket === b2.bucket && b2.music.endpoint === b2.endpoint) {
    throw new Error('B2_MUSIC_BUCKET is the same bucket as B2_BUCKET. Nothing to copy.');
  }

  const source = await listObjects('public', MUSIC_FOLDER);
  const dest = new Map((await listObjects('music', MUSIC_FOLDER)).map((o) => [o.key, o.size]));
  const report: CopyReport = { inPublic: source.length, alreadyThere: 0, copied: [], failed: [], missingFromMusic: [] };

  for (const o of source) {
    if (dest.get(o.key) === o.size) {
      report.alreadyThere++;
      continue;
    }
    if (!opts.execute) {
      log(`would copy  ${o.key}  (${o.size} bytes)`);
      report.copied.push(o.key);
      continue;
    }
    try {
      await copyBetweenStores('public', 'music', o.key);
      log(`copied      ${o.key}  (${o.size} bytes)`);
      report.copied.push(o.key);
    } catch (err) {
      const error = (err as Error).message;
      log(`FAILED      ${o.key}: ${error}`);
      report.failed.push({ key: o.key, error });
    }
  }

  const present = opts.execute
    ? new Set((await listObjects('music', MUSIC_FOLDER)).map((o) => o.key))
    : new Set([...dest.keys(), ...report.copied]);
  report.missingFromMusic = databaseKeys().filter((k) => !present.has(k));
  return report;
}

if (import.meta.main) {
  const execute = process.argv.includes('--execute');
  const { b2 } = getConfig();
  console.log(`from: ${b2.bucket}/${b2.keyPrefix}${MUSIC_FOLDER}  (public)`);
  console.log(`to:   ${b2.music?.bucket ?? '(B2_MUSIC_BUCKET not set)'}/${b2.music?.keyPrefix ?? ''}${MUSIC_FOLDER}  (private)`);
  console.log(execute ? 'COPYING\n' : 'DRY RUN: nothing will be written. Add --execute to copy.\n');
  try {
    const r = await copyMusicToPrivate({ execute, log: (l) => console.log(l) });
    console.log(`\n${r.inPublic} objects in the public bucket`);
    console.log(`${r.alreadyThere} already in the music bucket`);
    console.log(`${r.copied.length} ${execute ? 'copied' : 'to copy'}`);
    if (r.failed.length) console.log(`${r.failed.length} FAILED (run again to retry)`);
    if (r.missingFromMusic.length) {
      console.log(`\n${r.missingFromMusic.length} file(s) in the database ${execute ? 'are' : 'would still be'} missing from the music bucket:`);
      for (const k of r.missingFromMusic) console.log(`  ${k}`);
    } else {
      console.log(`\nEvery file in the database ${execute ? 'is' : 'would be'} in the music bucket.`);
    }
    process.exit(r.failed.length || r.missingFromMusic.length ? 1 : 0);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(2);
  }
}
