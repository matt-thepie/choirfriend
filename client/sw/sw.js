/* choirfriend service worker.
 *
 * Built by the `choirfriend-sw` Vite plugin, which prepends VERSION (a hash of
 * this file plus the build output) and PRECACHE (every built asset plus the
 * static files in public/). A new build therefore installs a new worker.
 *
 * What works offline:
 *   - the app shell (HTML, JS, CSS, icons, fonts, piano samples): precached
 *   - pages already visited (set lists, songs, annotations): GET /api and
 *     /auth/me are network-first with the last good response as fallback,
 *     also used when the network takes longer than API_TIMEOUT_MS
 *   - sheet music: any .pdf, and the MusicXML behind flowing scores (.xml), is
 *     cache-first in the `scores` cache, filled when a score is opened and by
 *     the score sync in the app (lib/offline.ts)
 *   - the flowing-score engraver (Verovio, ~7 MB): kept out of the precache so
 *     not every member downloads it on every deploy; cache-first in its own
 *     `engraver` cache once someone opens a flowing score. Its file name
 *     carries a content hash, so a new version simply replaces the old.
 * Learning tracks are deliberately left to the network.
 */
/* global VERSION, PRECACHE */

const SHELL = `shell-${VERSION}`;
const API = 'api-v1';
const SCORES = 'scores-v1';
const FONTS = 'fonts-v1';
const ENGRAVER = 'engraver-v1';
// Scores the page has engraved, saved by lib/flowing/engine.ts (ENGRAVED_CACHE).
const ENGRAVED = 'engraved-v1';
const KEEP = new Set([SHELL, API, SCORES, FONTS, ENGRAVER, ENGRAVED]);

const FONT_CSS =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Tinos:ital,wght@0,400;0,700;1,400;1,700&family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0..1,0&display=swap';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL);
      await shell.addAll(PRECACHE);
      // Fonts are best effort: the app still works with fallback faces.
      try {
        const fonts = await caches.open(FONTS);
        const css = await fetch(FONT_CSS, { mode: 'cors' });
        if (css.ok) {
          const text = await css.clone().text();
          await fonts.put(FONT_CSS, css);
          const files = [...text.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]);
          await Promise.all(files.map((u) => fonts.add(new Request(u, { mode: 'cors' })).catch(() => {})));
        }
      } catch {
        /* offline during install: fonts get cached on first use instead */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (!KEEP.has(key)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (/\.(pdf|xml)$/i.test(url.pathname)) {
    if (req.headers.has('range')) return; // pdf.js is told not to use ranges
    event.respondWith(scoreFirst(req));
    return;
  }
  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    event.respondWith(cacheFirst(req, FONTS));
    return;
  }
  if (url.origin === self.location.origin && url.pathname.startsWith('/fonts/')) {
    // The music fonts for flowing scores: fetched when one is first opened.
    event.respondWith(cacheFirst(req, FONTS));
    return;
  }
  if (url.origin !== self.location.origin) return; // audio on the CDN etc: network only

  if (req.mode === 'navigate') {
    event.respondWith(navigation(req));
    return;
  }
  if (url.pathname === '/api/health') return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/auth/me') {
    event.respondWith(apiNetworkFirst(event, req, url));
    return;
  }
  if (url.pathname.startsWith('/auth/')) return;
  if (url.pathname.startsWith('/imported/')) return; // locally stored tracks
  if (/^\/assets\/verovio-/.test(url.pathname)) {
    event.respondWith(engraverFirst(req));
    return;
  }
  event.respondWith(cacheFirst(req, SHELL));
});

async function navigation(req) {
  const shell = await caches.open(SHELL);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    // nginx answers every app route with index.html; keep the freshest copy.
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
      await shell.put('/index.html', res.clone());
    }
    return res;
  } catch {
    return (await shell.match('/index.html')) || (await shell.match('/')) || Response.error();
  }
}

/** How long a slow connection gets before a saved copy is shown instead. The
 *  network answer still lands in the cache for next time. */
const API_TIMEOUT_MS = 3000;

function offlineCopy(hit) {
  const headers = new Headers(hit.headers);
  headers.set('X-Choirfriend-Offline', '1');
  return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
}

async function apiNetworkFirst(event, req, url) {
  const cache = await caches.open(API);
  const net = fetch(req).then((res) => {
    if (res.ok) {
      // Cache in the background: the page shouldn't wait on the disk write.
      event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
    } else if (res.status === 401 && url.pathname === '/auth/me') {
      // Signed out (or someone else signing in next): drop the last user's data.
      event.waitUntil(caches.delete(API));
    }
    return res;
  });
  event.waitUntil(net.catch(() => {}));
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) {
    let timer;
    const slow = new Promise((resolve) => { timer = setTimeout(() => resolve(null), API_TIMEOUT_MS); });
    const res = await Promise.race([net, slow]).catch(() => null);
    clearTimeout(timer);
    return res ?? offlineCopy(hit);
  }
  try {
    return await net;
  } catch {
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'X-Choirfriend-Offline': '1' },
    });
  }
}

async function scoreFirst(req) {
  const cache = await caches.open(SCORES);
  const hit = await cache.match(req.url, { ignoreVary: true, ignoreSearch: false });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.status === 200) await cache.put(req.url, res.clone());
  return res;
}

async function engraverFirst(req) {
  const cache = await caches.open(ENGRAVER);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.status === 200) {
    // Only the current build's engraver is worth keeping.
    for (const old of await cache.keys()) await cache.delete(old);
    await cache.put(req, res.clone());
  }
  return res;
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.status === 200) await cache.put(req, res.clone());
  return res;
}
