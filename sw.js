/* Service worker de DoofApp.
   Cachea solo el cascarón (HTML, CSS, JS, iconos). NUNCA la API: el chat en vivo no se puede
   servir de una copia vieja, y por ella viaja el token, y la app ya sabe mostrar "PC sin conexión" sola.
   El bloque de push queda listo para la fase 3 (avisos con la app cerrada). */

const VERSION = 'doofapp-a7b54fa599';
// Con mala señal el HTML no debe esperar a que el fetch falle solo: pasado este tiempo se abre la copia guardada.
const ESPERA_RED_NAVEGACION_MS = 2500;
const CASCARON = [
  './',
  'manifest.webmanifest',
  'static/app.css?v=a7b54fa599',
  'static/app.js?v=a7b54fa599',
  'static/mini_doof.js?v=a7b54fa599',
  'static/iconos/ojo.svg',
  'static/iconos/icono-192.png',
  'static/iconos/icono-512.png',
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    // `cache: 'reload'` salta la caché HTTP: GitHub Pages sirve con max-age de 10 min, y con addAll a secas una versión nueva podía guardar el app.js VIEJO
    // (9 nov 2026: un teléfono se quedó con el botón de avisos de la versión anterior pese a haber publicado dos versiones después).
    caches.open(VERSION).then((cache) => Promise.all(CASCARON.map((ruta) =>
      fetch(new Request(ruta, { cache: 'reload' })).then((respuesta) => {
        if (!respuesta.ok) throw new Error('no pude bajar ' + ruta);
        return cache.put(ruta, respuesta);
      })))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((c) => c !== VERSION).map((c) => caches.delete(c))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evento) => {
  const pedido = evento.request;
  if (pedido.method !== 'GET') return;

  const url = new URL(pedido.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;   // la API siempre va a la red

  if (pedido.mode === 'navigate') {
    evento.respondWith(
      Promise.race([
        fetch(pedido.url, { cache: 'no-cache', credentials: 'same-origin' }),     // el HTML manda: de él salen los ?v= de los demás archivos
        new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('lenta')), ESPERA_RED_NAVEGACION_MS)),
      ]).catch(() => caches.match('./').then((copia) => copia || fetch(pedido)))
    );
    return;
  }

  evento.respondWith(
    caches.match(pedido).then((cacheado) => {
      const red = fetch(new Request(pedido, { cache: 'no-cache' }))      // revalida con el servidor (304 si no cambió) en vez de fiarse de la caché HTTP
        .then((respuesta) => {
          if (respuesta && respuesta.ok) {
            const copia = respuesta.clone();
            caches.open(VERSION).then((cache) => cache.put(pedido, copia));
          }
          return respuesta;
        })
        .catch(() => cacheado);
      return cacheado || red;
    })
  );
});

// ---------------------------------------------------------------- push (fase 3)
self.addEventListener('push', (evento) => {
  let datos = {};
  try { datos = evento.data ? evento.data.json() : {}; } catch (e) { datos = { cuerpo: evento.data && evento.data.text() }; }
  const titulo = datos.titulo || 'Doof';
  const opciones = {
    body: datos.cuerpo || 'Tienes algo pendiente.',
    icon: 'static/iconos/icono-192.png',
    badge: 'static/iconos/icono-192.png',
    tag: datos.etiqueta || 'doof',
    renotify: !!datos.etiqueta,
    data: { url: datos.url || './' },
    vibrate: [40, 30, 40],
  };
  evento.waitUntil(self.registration.showNotification(titulo, opciones));
});

self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();
  const destino = new URL(evento.notification.data?.url || './', self.location).href;
  evento.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
      for (const ventana of ventanas) {
        if (ventana.url.startsWith(self.location.origin)) {
          ventana.navigate(destino);
          return ventana.focus();
        }
      }
      return self.clients.openWindow(destino);
    })
  );
});
