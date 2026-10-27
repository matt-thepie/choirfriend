/**
 * Offline score sync. Sheet music PDFs are copied into the `scores-v1` cache,
 * which the service worker (client/sw/sw.js) serves cache-first, so a synced
 * score opens with no connection. Learning tracks stay online-only.
 *
 * Scope is a per-device choice kept in localStorage:
 *   'setlists' (default) — scores for songs on an active set list
 *   'all'                — every score in the repertoire
 *   'off'                — no background sync (opened scores are still cached)
 */

export const SCORES_CACHE = 'scores-v1';
export type OfflineScope = 'setlists' | 'all' | 'off';

export interface ScoreEntry {
  fileId: number;
  pieceId: number;
  pieceTitle: string;
  url: string;
  sizeBytes: number | null;
  inSetList: boolean;
}

export interface OfflineStatus {
  supported: boolean;
  scope: OfflineScope;
  wanted: number;
  saved: number;
  wantedBytes: number;
  allBytes: number;
  allCount: number;
  lastSync: number | null;
}

const SCOPE_KEY = 'choirfriend.offlineScope';
const LAST_KEY = 'choirfriend.offlineLastSync';

export const offlineSupported = typeof window !== 'undefined' && 'caches' in window && 'serviceWorker' in navigator;

export function getScope(): OfflineScope {
  try {
    const v = localStorage.getItem(SCOPE_KEY);
    if (v === 'setlists' || v === 'all' || v === 'off') return v;
  } catch {
    /* storage blocked */
  }
  return 'setlists';
}

export function setScope(scope: OfflineScope): void {
  try {
    localStorage.setItem(SCOPE_KEY, scope);
  } catch {
    /* storage blocked */
  }
}

function getLastSync(): number | null {
  try {
    const v = Number(localStorage.getItem(LAST_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

async function fetchScoreList(): Promise<ScoreEntry[]> {
  const res = await fetch('/api/offline/scores', { credentials: 'include' });
  if (!res.ok) throw new Error(`score list: HTTP ${res.status}`);
  const body = (await res.json()) as { scores: ScoreEntry[] };
  return body.scores;
}

function inScope(s: ScoreEntry, scope: OfflineScope): boolean {
  return scope === 'all' || (scope === 'setlists' && s.inSetList);
}

async function cachedUrls(): Promise<Set<string>> {
  const cache = await caches.open(SCORES_CACHE);
  return new Set((await cache.keys()).map((r) => r.url));
}

export async function getStatus(): Promise<OfflineStatus> {
  const scope = getScope();
  const base: OfflineStatus = { supported: offlineSupported, scope, wanted: 0, saved: 0, wantedBytes: 0, allBytes: 0, allCount: 0, lastSync: getLastSync() };
  if (!offlineSupported) return base;
  const list = await fetchScoreList();
  const have = await cachedUrls();
  const wanted = list.filter((s) => inScope(s, scope === 'off' ? 'setlists' : scope));
  return {
    ...base,
    wanted: wanted.length,
    saved: wanted.filter((s) => have.has(new URL(s.url, location.href).href)).length,
    wantedBytes: wanted.reduce((n, s) => n + (s.sizeBytes ?? 0), 0),
    allBytes: list.reduce((n, s) => n + (s.sizeBytes ?? 0), 0),
    allCount: list.length,
  };
}

export interface SyncProgress {
  done: number;
  total: number;
  failed: number;
}

/**
 * Download every in-scope score that is not cached yet, and drop cached
 * scores that no longer exist (deleted or replaced files get new URLs).
 * Scores outside the scope but already cached are kept: they were opened.
 */
export async function syncScores(scope: OfflineScope, onProgress?: (p: SyncProgress) => void): Promise<SyncProgress> {
  const list = await fetchScoreList();
  const cache = await caches.open(SCORES_CACHE);
  const known = new Set(list.map((s) => new URL(s.url, location.href).href));
  for (const req of await cache.keys()) if (!known.has(req.url)) await cache.delete(req);

  const have = await cachedUrls();
  const todo = list
    .filter((s) => inScope(s, scope))
    .map((s) => new URL(s.url, location.href).href)
    .filter((u) => !have.has(u));
  // Warm the service worker's API cache too, so set lists and the song pages
  // that hold these scores open offline, not just the PDFs themselves.
  const pieceIds = [...new Set(list.filter((s) => inScope(s, scope)).map((s) => s.pieceId))];
  await warmApi(pieceIds);

  const progress: SyncProgress = { done: 0, total: todo.length, failed: 0 };
  onProgress?.({ ...progress });
  if (todo.length) void navigator.storage?.persist?.().catch(() => false);

  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const url = todo[next++];
      try {
        const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        await cache.put(url, res);
      } catch {
        progress.failed++;
      }
      progress.done++;
      onProgress?.({ ...progress });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (progress.failed === 0) {
    try {
      localStorage.setItem(LAST_KEY, String(Date.now()));
    } catch {
      /* storage blocked */
    }
  }
  return progress;
}

async function warmApi(pieceIds: number[]): Promise<void> {
  const get = (u: string) => fetch(u, { credentials: 'include' }).then((r) => (r.ok ? r : null)).catch(() => null);
  const urls = ['/auth/me', '/api/sections', '/api/pieces', '/api/setlists/all'];
  const lists = await get('/api/setlists');
  if (lists) {
    const body = (await lists.json()) as { id: number; status: string }[] | { setLists?: { id: number; status: string }[] };
    const rows = Array.isArray(body) ? body : body.setLists ?? [];
    for (const l of rows) if (l.status === 'active') urls.push(`/api/setlists/${l.id}`);
  }
  for (const id of pieceIds) urls.push(`/api/pieces/${id}`, `/api/pieces/${id}/annotations`);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) await get(urls[next++]);
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

/** True when an automatic background sync is reasonable right now. */
export function autoSyncAllowed(): boolean {
  if (!offlineSupported || !navigator.onLine || getScope() === 'off') return false;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; type?: string } }).connection;
  if (conn?.saveData) return false;
  if (conn?.type === 'cellular') return false; // manual sync still works on mobile data
  return true;
}

export function formatMB(bytes: number): string {
  const mb = bytes / 1048576;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}
