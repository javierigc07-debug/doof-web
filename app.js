'use strict';
/* Prueba de la Fase 0: ¿puede una app fija en GitHub Pages hablar con la PC a través de un quick
   tunnel cuya dirección cambia? La dirección viaja cifrada en tunel.json (rama "tunel"), para que
   el repo público no se la regale a nadie: solo la lee quien ya tiene el token. */

const URL_TUNEL = 'https://api.github.com/repos/javierigc07-debug/doof-web/contents/tunel.json?ref=tunel';
const CONSULTA_CORTA_MS = 3000;
const ESPERA_LARGA_S = 25;
const REINTENTO_TUNEL_MS = 10000;
const MENSAJES_POR_MODO = 8;

const $ = (id) => document.getElementById(id);
const S = { token: '', base: '', modo: 'corto', ultimo: 0, conectado: false, generacion: 0,
            peticiones: 0, bytes: 0, esperando: new Map(), caidaDesde: 0 };

function leerToken() { try { return localStorage.getItem('doof_token') || ''; } catch { return ''; } }
function guardarToken(t) { try { localStorage.setItem('doof_token', t); } catch { /* sigue en memoria */ } }
function borrarToken() { try { localStorage.removeItem('doof_token'); } catch { /* nada que borrar */ } }

function anotar(texto) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()} ${texto}`;
  const lista = $('registro');
  lista.prepend(li);
  while (lista.children.length > 40) lista.lastChild.remove();
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function descifrar(sobre, token) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), 'PBKDF2', false, ['deriveKey']);
  const clave = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64(sobre.sal), iterations: sobre.iteraciones },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const claro = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(sobre.iv) }, clave, b64(sobre.cifrado));
  return JSON.parse(new TextDecoder().decode(claro));
}

async function buscarTunel() {
  const r = await fetch(`${URL_TUNEL}&_=${Date.now()}`, {
    headers: { Accept: 'application/vnd.github.raw' }, cache: 'no-store', referrerPolicy: 'no-referrer' });
  if (!r.ok) throw new Error(`GitHub respondió ${r.status}`);
  return descifrar(await r.json(), S.token);
}

async function api(ruta, opciones = {}) {
  S.peticiones += 1;
  const r = await fetch(S.base + ruta, {
    ...opciones, cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: { 'X-Doof-Token': S.token, ...(opciones.headers || {}) },
  });
  const texto = await r.text();
  S.bytes += texto.length;
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.estado = r.status; throw e; }
  return JSON.parse(texto);
}

function atender(evento) {
  if (evento.rol !== 'bot') return;
  const id = evento.responde_a;
  const espera = S.esperando.get(id);
  if (espera) { S.esperando.delete(id); espera(evento); return; }
  anotar(`Doof: ${evento.texto}`);
}

/* Una sola vuelta viva a la vez: "generacion" mata la anterior al cambiar de modo o reconectar. */
async function bucleConsultas(generacion) {
  while (generacion === S.generacion) {
    if (document.hidden) { await dormir(1000); continue; }
    try {
      const espera = S.modo === 'largo' ? ESPERA_LARGA_S : 0;
      const datos = await api(`/api/novedades?desde=${S.ultimo}&espera=${espera}`);
      if (generacion !== S.generacion) return;
      S.ultimo = datos.ultimo;
      datos.eventos.forEach(atender);
      if (S.modo === 'corto') await dormir(CONSULTA_CORTA_MS);
    } catch (e) {
      if (generacion !== S.generacion) return;
      if (e.estado === 401) { pedirToken('El servidor rechazó ese token.'); return; }
      anotar(`Se cayó la conexión: ${e.message}`);
      reconectar();
      return;
    }
  }
}

function pedirToken(error = '') {
  S.generacion += 1;
  S.conectado = false;
  $('panel').hidden = true;
  $('entrada').hidden = false;
  $('error-token').textContent = error;
}

/* Tras una caída: leer la dirección publicada y probarla hasta que conteste. Mide desde la primera
   falla hasta tener conexión, que es lo que Javier sentiría al reiniciar la PC. */
async function reconectar() {
  const generacion = ++S.generacion;
  S.conectado = false;
  $('enviar').disabled = true;
  $('medir').disabled = true;
  S.caidaDesde = S.caidaDesde || Date.now();
  $('estado').textContent = 'Buscando a Doof...';
  while (generacion === S.generacion) {
    try {
      const { url, publicado } = await buscarTunel();
      S.base = url;
      await api('/api/salud');
      const datos = await api('/api/novedades?desde=0&espera=0');
      if (generacion !== S.generacion) return;
      S.ultimo = datos.ultimo;
      S.conectado = true;
      $('enviar').disabled = false;
      $('medir').disabled = false;
      const tardo = Math.round((Date.now() - S.caidaDesde) / 1000);
      const desdePublicado = Math.round(Date.now() / 1000 - publicado);
      S.caidaDesde = 0;
      $('estado').textContent = `Conectado (modo ${S.modo}).`;
      anotar(`Conectado en ${tardo} s; la dirección se publicó hace ${desdePublicado} s.`);
      bucleConsultas(generacion);
      return;
    } catch (e) {
      if (e.name === 'OperationError') { pedirToken('Ese token no abre la dirección publicada.'); return; }
      $('estado').textContent = 'Doof no responde. ¿La PC está prendida? Sigo intentando...';
      anotar(`Sin conexión todavía: ${e.message}`);
      await dormir(REINTENTO_TUNEL_MS);
    }
  }
}

function enviarYEsperar(texto) {
  const id = crypto.randomUUID();
  const inicio = performance.now();
  return new Promise((resolver, rechazar) => {
    const reloj = setTimeout(() => { S.esperando.delete(id); rechazar(new Error('sin respuesta en 60 s')); }, 60000);
    S.esperando.set(id, (evento) => { clearTimeout(reloj); resolver({ ms: performance.now() - inicio, evento }); });
    api('/api/mensaje', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, texto }),
    }).catch((e) => { clearTimeout(reloj); S.esperando.delete(id); rechazar(e); });
  });
}

function cambiarModo(modo) {
  S.modo = modo;
  const generacion = ++S.generacion;
  bucleConsultas(generacion);
}

async function medirModo(modo) {
  cambiarModo(modo);
  await dormir(500);
  const antes = { peticiones: S.peticiones, bytes: S.bytes, inicio: Date.now() };
  const tiempos = [];
  for (let i = 0; i < MENSAJES_POR_MODO; i += 1) {
    $('estado').textContent = `Midiendo modo ${modo}: ${i + 1} de ${MENSAJES_POR_MODO}...`;
    const { ms } = await enviarYEsperar(`medición ${modo} ${i + 1}`);
    tiempos.push(ms);
    await dormir(2500 + Math.random() * 1000);   // que la respuesta no caiga siempre igual respecto al ciclo de consulta
  }
  const minutos = (Date.now() - antes.inicio) / 60000;
  tiempos.sort((a, b) => a - b);
  return {
    modo,
    mediana_ms: Math.round(tiempos[Math.floor(tiempos.length / 2)]),
    peor_ms: Math.round(tiempos[tiempos.length - 1]),
    peticiones_por_minuto: Math.round((S.peticiones - antes.peticiones) / minutos),
    cuerpo_bytes_por_minuto: Math.round((S.bytes - antes.bytes) / minutos),
  };
}

async function medir() {
  $('medir').disabled = true;
  $('enviar').disabled = true;
  try {
    const resultados = [await medirModo('corto'), await medirModo('largo')];
    $('resultados').textContent = JSON.stringify(resultados, null, 2);
    anotar('Medición terminada.');
  } catch (e) {
    $('resultados').textContent = `La medición falló: ${e.message}`;
  } finally {
    $('medir').disabled = false;
    $('enviar').disabled = false;
    $('estado').textContent = S.conectado ? `Conectado (modo ${S.modo}).` : $('estado').textContent;
  }
}

async function enviar() {
  const texto = $('texto').value.trim();
  if (!texto) return;
  $('texto').value = '';
  anotar(`Yo: ${texto}`);
  try {
    const { ms, evento } = await enviarYEsperar(texto);
    anotar(`Doof (${Math.round(ms)} ms): ${evento.texto}`);
  } catch (e) {
    anotar(`No se pudo enviar: ${e.message}`);
  }
}

function iniciar() {
  S.token = leerToken();
  if (!S.token) { pedirToken(); return; }
  $('entrada').hidden = true;
  $('panel').hidden = false;
  reconectar();
}

$('guardar').addEventListener('click', () => {
  const token = $('token').value.trim();
  if (!token) { $('error-token').textContent = 'Falta el token.'; return; }
  $('token').value = '';
  guardarToken(token);
  iniciar();
});
$('enviar').addEventListener('click', enviar);
$('texto').addEventListener('keydown', (e) => { if (e.key === 'Enter') enviar(); });
$('medir').addEventListener('click', medir);
$('olvidar').addEventListener('click', () => { borrarToken(); S.token = ''; pedirToken(); });

let avisoInstalar = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); avisoInstalar = e; $('instalar').hidden = false; });
$('instalar').addEventListener('click', async () => {
  if (!avisoInstalar) return;
  avisoInstalar.prompt();
  await avisoInstalar.userChoice;
  avisoInstalar = null;
  $('instalar').hidden = true;
});
window.addEventListener('appinstalled', () => anotar('App instalada.'));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => anotar(`Sin service worker: ${e.message}`));
iniciar();
