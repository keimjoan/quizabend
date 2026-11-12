// Offline-Speicher für die Webapp im Netz (GitHub Pages). In Claude und per Doppelklick läuft er nicht.
// Eigene Dateien: erst aus dem Netz, sonst aus dem Speicher. So kommt jede neue Version sofort an,
// und das Spiel startet trotzdem ohne Internet. Schriften von Google: einmal laden, danach aus dem Speicher.
const CACHE = 'quizabend-v2';
const CORE = ['./', './index.html', './boards.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function keep(req, res) {
  const copy = res.clone();
  caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req)
      .then(res => res.ok ? keep(req, res) : res)
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))));
  } else if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req)
      .then(res => (res.ok || res.type === 'opaque') ? keep(req, res) : res)));
  }
});
