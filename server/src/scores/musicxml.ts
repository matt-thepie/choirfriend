/**
 * Tidy MuseScore's MusicXML export before it is engraved in the browser.
 * String surgery rather than a DOM: Node has no XML parser built in, and the
 * elements touched here (part, score-part, note, lyric) never nest in
 * themselves, so matching start to end tag is exact.
 */

/** Drop the DOCTYPE: it points at an external DTD nobody needs to fetch. */
function stripDoctype(xml: string): string {
  return xml.replace(/<!DOCTYPE[^>]*>\s*/i, '');
}

/** A lyric entered twice on the same note (same verse, same text) exports as
 *  two <lyric> elements that print on top of each other. Keep the first. */
function dedupeLyrics(xml: string): { xml: string; removed: number } {
  let removed = 0;
  const out = xml.replace(/<note(?=[\s>])[\s\S]*?<\/note>/g, (note) => {
    const seen = new Set<string>();
    return note.replace(/[ \t]*<lyric(?=[\s>])([^>]*)>([\s\S]*?)<\/lyric>\s*?\n?/g, (whole, attrs: string, body: string) => {
      const verse = /number="([^"]*)"/.exec(attrs)?.[1] ?? '1';
      const text = [...body.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join('|');
      const key = `${verse}\u0000${text}`;
      if (seen.has(key)) {
        removed++;
        return '';
      }
      seen.add(key);
      return whole;
    });
  });
  return { xml: out, removed };
}

/** Parts with no sounding note at all (e.g. a rehearsal-piano stave that was
 *  never filled in) are removed, so they neither print nor play. */
function dropEmptyParts(xml: string): { xml: string; dropped: string[] } {
  const dropped: string[] = [];
  let out = xml.replace(/<part\s+id="([^"]+)"[^>]*>[\s\S]*?<\/part>\s*/g, (block, id: string) => {
    if (/<(pitch|unpitched)>/.test(block)) return block;
    dropped.push(id);
    return '';
  });
  // Never leave a score with no parts: if everything was empty, keep it as is.
  if (!/<part\s+id=/.test(out)) return { xml, dropped: [] };
  for (const id of dropped) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`[ \\t]*<score-part\\s+id="${escaped}"[^>]*>[\\s\\S]*?<\\/score-part>\\s*`), '');
  }
  return { xml: out, dropped };
}

export interface CleanResult {
  xml: string;
  duplicateLyrics: number;
  droppedParts: string[];
}

export function cleanMusicXml(raw: string): CleanResult {
  const a = stripDoctype(raw);
  const b = dedupeLyrics(a);
  const c = dropEmptyParts(b.xml);
  return { xml: c.xml, duplicateLyrics: b.removed, droppedParts: c.dropped };
}
