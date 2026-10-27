/* choirfriend service worker.
 *
 * Built by the `choirfriend-sw` Vite plugin, which prepends VERSION (a hash of
 * this file plus the build output) and PRECACHE (every built asset plus the
 * static files in public/). A new build therefore installs a new worker.
 *
 * What works offline:
 *   - the app shell (HTML, JS, CSS, icons, fonts, piano samples): precached
 *   - pages already visited (set lists, songs, annotations): GET /api and
 *     /auth/me are network-first with the last good response as fallback
 *   - sheet music: any .pdf is cache-first in the `scores` cache, filled when a
 *     score is opened and by the score sync in the app (lib/offline.ts)
 * Learning tracks are deliberately left to the network.
 */
/* global VERSION, PRECACHE */

const SHELL = `shell-${VERSION}`;
const API = 'api-v1';
const SCORES = 'scores-v1';
const FONTS = 'fonts-v1';
const KEEP = new Set([SHELL, API, SCORES, FONTS]);

const FONT_CSS =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0..1,0&display=swap';

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

  if (url.pathname.toLowerCase().endsWith('.pdf')) {
    if (req.headers.has('range')) return; // pdf.js is told not to use ranges
    event.respondWith(scoreFirst(req));
    return;
  }
  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
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
    event.respondWith(apiNetworkFirst(req, url));
    return;
  }
  if (url.pathname.startsWith('/auth/')) return;
  if (url.pathname.startsWith('/imported/')) return; // locally stored tracks
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

async function apiNetworkFirst(req, url) {
  const cache = await caches.open(API);
  try {
    const res = await fetch(req);
    if (res.ok) {
      await cache.put(req, res.clone());
    } else if (res.status === 401 && url.pathname === '/auth/me') {
      // Signed out (or someone else signing in next): drop the last user's data.
      await caches.delete(API);
    }
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('X-Choirfriend-Offline', '1');
      return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
    }
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

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.status === 200) await cache.put(req, res.clone());
  return res;
}
