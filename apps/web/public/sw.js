const CACHE = 'ofd-workstation-v2-shell-4';
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');
/* 설치 앱의 시작 경로는 '/' — 역할에 맞는 첫 화면으로 앱이 알아서 보낸다 */
const FALLBACK = `${BASE}/`;
const SHELL = [FALLBACK, `${BASE}/manifest.webmanifest`, `${BASE}/ofd-mark.svg`,
  `${BASE}/icon-192.png`, `${BASE}/apple-touch-icon.png`];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
    return response;
  }).catch(() => caches.match(request).then((cached) => cached || caches.match(FALLBACK))));
});
