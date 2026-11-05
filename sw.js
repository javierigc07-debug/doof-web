'use strict';
/* Red primero, caché de respaldo y solo para la interfaz: lo que va al túnel o a GitHub nunca se
   guarda, porque ahí viajan el token y los mensajes. */
const CACHE = 'doof-prueba-1';
const INTERFAZ = ['./', 'index.html', 'app.js', 'app.css', 'manifest.webmanifest', 'icono-192.png', 'icono-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(INTERFAZ)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((claves) => Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(fetch(e.request)
    .then((r) => {
      if (r.ok) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); }
      return r;
    })
    .catch(() => caches.match(e.request)));
});
