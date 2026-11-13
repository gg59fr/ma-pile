// Ma Pile service worker: the app shell opens offline, photos are kept once seen.
// Bump VERSION on every release so phones pick up the new files.
const VERSION = 'v2';
const SHELL = `mapile-shell-${VERSION}`;
const RUNTIME = 'mapile-runtime';
const PHOTOS = 'mapile-photos';
const SHELL_FILES = [
  './', './index.html', './styles.css', './app.js', './config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('mapile-shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Photos in Supabase Storage: cache first, they never change once uploaded.
  if (url.pathname.includes('/storage/v1/object/public/')) {
    e.respondWith(cacheFirst(req, PHOTOS));
    return;
  }
  // Supabase API and auth: always live.
  if (url.hostname.endsWith('.supabase.co')) return;

  // App files: network first so updates arrive, cache when offline.
  if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(req, SHELL));
    return;
  }
  // Libraries and fonts from CDNs: serve the cached copy, refresh in the background.
  if (/(^|\.)(jsdelivr\.net|googleapis\.com|gstatic\.com)$/.test(url.hostname)) {
    e.respondWith(staleWhileRevalidate(req, RUNTIME));
  }
});

async function cacheFirst(req, name){
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}
async function networkFirst(req, name){
  const cache = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return (await cache.match(req, { ignoreSearch: true }))
      || (req.mode === 'navigate' ? cache.match('./index.html') : Response.error());
  }
}
async function staleWhileRevalidate(req, name){
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const live = fetch(req).then(res => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await live) || Response.error();
}
