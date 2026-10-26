// Minimal service worker: makes the app installable on Android/Chrome.
// Deliberately no caching yet — scores and tracks come from the CDN and the
// API must stay live. Offline support is a later, separate piece of work.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
