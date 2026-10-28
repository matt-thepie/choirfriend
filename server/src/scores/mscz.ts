import { unzipSync, zipSync } from 'fflate';

/**
 * A score saved while MuseScore showed it in continuous view keeps that
 * layout, and exports as one endless page with no page breaks. Choirs say
 * "top of page 3", so convert it in page view: the MusicXML then carries
 * MuseScore's own line and page breaks.
 */
const stripLayoutMode = (mscx: string) => mscx.replace(/<layoutMode>[^<]*<\/layoutMode>\s*/g, '');

export function forcePageView(bytes: Uint8Array, ext: string): Uint8Array {
  if (ext === '.mscx') return Buffer.from(stripLayoutMode(Buffer.from(bytes).toString('utf8')), 'utf8');
  if (ext !== '.mscz') return bytes;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return bytes; // let MuseScore report what's wrong with it
  }
  let changed = false;
  for (const [name, data] of Object.entries(entries)) {
    if (!name.endsWith('.mscx')) continue;
    const before = Buffer.from(data).toString('utf8');
    const after = stripLayoutMode(before);
    if (after !== before) {
      entries[name] = Buffer.from(after, 'utf8');
      changed = true;
    }
  }
  return changed ? zipSync(entries) : bytes;
}
