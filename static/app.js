/* DoofApp — la lógica del cliente. Sin frameworks: un archivo, estados chiquitos y el mismo
   contrato que ya usa el HUD (POST /mensaje, /conversaciones). La app no habla con Telegram ni con el
   bot: habla con el puente de servidor.py. Se sirve desde GitHub Pages (dirección fija) y encuentra ese
   puente a través de un quick tunnel, cuya dirección cambia y se publica cifrada. */

(() => {
  'use strict';

  const $ = (sel, raiz = document) => raiz.querySelector(sel);
  const $$ = (sel, raiz = document) => Array.from(raiz.querySelectorAll(sel));

  const S = {
    vista: 'inicio',
    sesion: null,
    sesionVista: null,
    inicioVista: null,
    mensajes: [],
    conversaciones: [],
    esperando: false,
    desde: 0,
    herramienta: '',
    conectado: null,          // null = todavía no sé, true/false = cómo le fue a la última consulta
    salud: null,
    soloLectura: false,
    adjunto: null,
    adjuntoUrl: null,
    cargado: false,
    token: '',
    base: '',                 // dirección del puente; vacía si la app se abre desde el propio puente
    cursor: -1,               // último evento recibido de /novedades
    ciclo: null,              // cambia si servidor.py reinicia: los números de evento ya no valen
    vuelta: 0,                // cambiarla deja sin efecto cualquier bucle de red anterior
    conectando: false,
    sobreEnlace: null,
    evitarRepetidos: false,
    enlaceInicialVisto: false,
    aprobaciones: [],
    huellaRegistrada: false,
    pidiendoCodigo: false,
    instalable: null,
    filtroHistorial: '',
    luz: null,
    luzFalla: null,
    pc: null,
    pcFalla: null,
    apagadoHasta: 0,          // en el reloj del teléfono: el servidor manda cuánto falta, no una hora
    turnoSeccion: 0,          // cambiarlo deja sin efecto el refresco de una sección que ya no se ve
    arranque: null,           // lo que entregó /arranque en el último sondeo; ponerseAlDia lo consume
    sinArranque: false,       // el puente es viejo y no tiene /arranque: se sigue por /salud
    luzLeida: null,
    cache: null,              // lo último que se vio, para pintar el inicio antes de que conteste la PC
    pcLeida: null,
  };

  const NOMBRE = 'Javier';
  const VERSION = '2026.11.07';
  const MAX_MENSAJES = 200;
  const MAX_BYTES = 25 * 1024 * 1024;
  const ES_REMOTO = location.hostname.endsWith('.github.io');
  const URL_DIRECCION = 'https://api.github.com/repos/javierigc07-debug/doof-web/contents/tunel.json?ref=tunel';
  const PATRON_TUNEL = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;
  const ESPERA_NOVEDADES_S = 25;
  // Probar la dirección conocida no gasta nada, así que se hace seguido: esperar hasta 5 min aquí dejaba a Javier sin app con la PC ya de vuelta (6 nov 2026).
  const REINTENTOS_S = [5, 5, 10, 10, 15];
  // Lo que se espacia es leer la dirección publicada: GitHub da 60 lecturas por hora sin autenticar, y agotarlas dejaría a la app sin poder encontrar la PC cuando vuelva.
  // Seguido al principio, porque la PC rehace el túnel en un par de minutos. Son unas 40 en la primera hora.
  const espacioEntreLecturasS = (n) => (n < 6 ? 30 : n < 14 ? 60 : 120);
  const ESPERA_SI_GITHUB_LIMITA_S = 300;
  const REFRESCO_LUZ_MS = 15000;
  const REFRESCO_INICIO_MS = 30000;       // las tarjetas del inicio se renuevan solas mientras se mira
  const LUZ_FRESCA_MS = 3 * 60 * 1000;    // una lectura de luz más vieja que esto se rotula como "última lectura", nunca como "hay luz"
  const PC_FRESCA_MS = 2 * 60 * 1000;
  const CLAVE_CACHE = 'doof_cache_v1';
  const REFRESCO_PC_MS = 10000;
  const TIEMPO_LUZ_MS = 35000;
  const APAGANDO_COMO_MAXIMO_MS = 3 * 60 * 1000;   // si sigue viva pasado esto, Windows no llegó a apagarse
  const TIPO_APAGAR = 'apagar_pc';
  const TIPO_PAGO = 'pago_movil';
  const TIPO_LLAVE = 'mini_doof_llave';
  const TIPO_RESPONDER = 'responder_agente';
  const MAX_RESPUESTA_AGENTE = 2000;      // el bot rechaza más que esto
  const MAX_TEXTO_MINI = 200;     // la Pi recorta lo que pase de ahí sin avisar
  const MAX_MENSAJES_MINI = 30;
  const ESPERA_ABRIR_MINI_MS = 15000;
  const CERRAR_MINI_AL_OCULTAR_MS = 5 * 60 * 1000;
  const MINI_CON_CONFIRMACION = new Set(['encender', 'modo_seguro', 'modo_normal']);
  const TITULOS_DE_VISTA = { luz: 'Luz de la casa', pc: 'La PC', usdt: 'USDT', agentes: 'Agentes', mini: 'Charlene', 'agente-p': 'Agente P' };

  // Los botones que manda Telegram no tienen callback acá: se convierten al texto que el router
  // ya sabe interpretar. Es la misma tabla de static/mente.html, a propósito.
  const TEXTO_DE_BOTON = {
    'arch|resolver': 'resuélvelo',
    'arch|explicar': 'explícamelo',
    'arch|opinar': 'solo opina',
    'arch|descartar': 'nada, déjalo',
    'arch|probar': 'pruébalo',
  };

  const TOOL_ES = {
    buscar_en_curso: 'buscando en el aula',
    revisar_calendario: 'mirando el calendario',
    ver_semana: 'armando la semana',
    ver_notas: 'buscando calificaciones',
    mandar_whatsapp: 'escribiendo por WhatsApp',
    pagar_movil: 'preparando el pago',
    pago_aprobado: 'pagando en Ubii',
    convertir_moneda: 'calculando la tasa',
    comprar_usdt: 'revisando Binance',
    abrir_tutorial: 'buscando el tutorial',
    como_llegar: 'mirando las rutas',
    analizar_archivo: 'mirando el archivo',
    declarar_evento_academico: 'anotando la fecha',
    buscar_en_web: 'buscando en internet',
  };

  const ICONOS = {
    copiar: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/></svg>',
    archivo: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/></svg>',
    imagen: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 15l-5-5L5 20"/></svg>',
    pdf: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/><path d="M8 13h8M8 17h5"/></svg>',
    chat: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 01-8 8H7l-4 3v-6.5A8 8 0 1121 12z"/></svg>',
  };

  // ---------------------------------------------------------------- utilidades
  function limpiarHtml(t) {
    return String(t || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');
  }

  const normalizar = (t) => limpiarHtml(t).replace(/\s+/g, ' ').trim().toLowerCase();

  function pesoLegible(b) {
    if (!b) return '';
    return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  }

  function urlAdjunto(url) {
    if (!url) return null;
    return url.startsWith('/mente/adjunto/') ? '/api/adjunto/' + url.split('/').pop() : url;
  }

  // Un <img> no puede mandar el token en un encabezado: las vistas previas se piden aparte y se muestran como blob.
  const adjuntosCargados = new Map();
  async function ponerImagen(img, url) {
    try {
      if (!url.startsWith('/api/')) { img.src = url; return; }
      if (!adjuntosCargados.has(url)) {
        const r = await fetch(S.base + url, { headers: { 'X-Doof-Token': S.token }, referrerPolicy: 'no-referrer' });
        if (!r.ok) throw new Error('error ' + r.status);
        adjuntosCargados.set(url, URL.createObjectURL(await r.blob()));
      }
      img.src = adjuntosCargados.get(url);
    } catch (e) {
      img.dispatchEvent(new Event('error'));
    }
  }

  function ojo(clase = 'chico') {
    const original = $('#barra .ojo');
    const nodo = original.cloneNode(true);
    nodo.setAttribute('class', 'ojo ' + clase);
    nodo.removeAttribute('id');
    return nodo;
  }

  function fechaLarga(d = new Date()) {
    return new Intl.DateTimeFormat('es-VE', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  }

  function capitalizar(t) {
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
  }

  function hora(d) {
    return new Intl.DateTimeFormat('es-VE', { hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  }

  function fechaCorta(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const hoy = new Date();
    const ayer = new Date(); ayer.setDate(hoy.getDate() - 1);
    const mismoDia = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (mismoDia(d, hoy)) return 'Hoy ' + hora(d);
    if (mismoDia(d, ayer)) return 'Ayer ' + hora(d);
    return new Intl.DateTimeFormat('es-VE', { day: 'numeric', month: 'short' }).format(d);
  }

  function grupoFecha(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return 'Anteriores';
    const hoy = new Date();
    const ayer = new Date(); ayer.setDate(hoy.getDate() - 1);
    const mismoDia = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (mismoDia(d, hoy)) return 'Hoy';
    if (mismoDia(d, ayer)) return 'Ayer';
    if ((hoy - d) / 86400000 < 7) return 'Últimos 7 días';
    return 'Anteriores';
  }

  function saludo() {
    const h = new Date().getHours();
    if (h < 6) return 'Buenas noches';
    if (h < 12) return 'Buenos días';
    if (h < 19) return 'Buenas tardes';
    return 'Buenas noches';
  }

  // ---------------------------------------------------------------- red
  function leerGuardado(clave) {
    try { return localStorage.getItem(clave) || ''; } catch (e) { return ''; }
  }

  function guardar(clave, valor) {
    try {
      if (valor) localStorage.setItem(clave, valor);
      else localStorage.removeItem(clave);
    } catch (e) { /* sigue en memoria mientras la app esté abierta */ }
  }

  function ponerBase(url) {
    S.base = url;
    if (ES_REMOTO) guardar('doof_base', url);
  }

  async function api(ruta, opciones = {}, tiempoMs = 20000, silencioso = false) {
    if (ES_REMOTO && !S.base) {
      const err = new Error('sin conexión con la PC');
      err.sinRed = true;
      throw err;
    }
    // Con tiempo máximo: si la PC se apaga de golpe, una consulta abierta puede quedar colgada sin fallar nunca.
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), tiempoMs);
    try {
      let r;
      try {
        r = await fetch(S.base + '/api' + ruta, {
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          ...opciones,
          signal: control.signal,
          headers: { ...(S.token ? { 'X-Doof-Token': S.token } : {}), ...(opciones.headers || {}) },
        });
      } catch (e) {
        const err = new Error('sin conexión con la PC');
        err.sinRed = true;
        throw err;
      }
      let datos = {};
      try { datos = await r.json(); } catch (e) { /* respuesta sin JSON */ }
      if (r.status === 401) {
        if (!silencioso) mostrarLogin('Ese token ya no sirve.');
        const err = new Error('no autorizado');
        err.status = 401;
        throw err;
      }
      if (!r.ok) {
        const err = new Error(datos.error || ('error ' + r.status));
        err.status = r.status;
        throw err;
      }
      return datos;
    } finally {
      clearTimeout(reloj);
    }
  }

  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  // Cifrado con autenticación: si esto abre, la dirección la publicó quien tiene el token. Por eso la app se la
  // cree y le manda el token, aunque el archivo esté en un repo público.
  async function abrirSobre(sobre) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(S.token), 'PBKDF2', false, ['deriveKey']);
    const clave = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: b64(sobre.sal), iterations: sobre.iteraciones },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const claro = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(sobre.iv) }, clave, b64(sobre.cifrado));
    const datos = JSON.parse(new TextDecoder().decode(claro));
    if (!PATRON_TUNEL.test(datos.url)) throw new Error('dirección inválida');
    return datos;
  }

  async function leerDireccionPublicada() {
    const r = await fetch(`${URL_DIRECCION}&_=${Date.now()}`, {
      headers: { Accept: 'application/vnd.github.raw' }, cache: 'no-store', referrerPolicy: 'no-referrer',
    });
    if (!r.ok) {
      const err = new Error('GitHub respondió ' + r.status);
      err.limiteGitHub = r.status === 403 || r.status === 429;
      throw err;
    }
    return abrirSobre(await r.json());
  }

  function sobreDelEnlace() {
    const m = location.hash.match(/^#s=(.+)$/);
    if (!m) return null;
    history.replaceState(history.state, '', location.pathname);
    try {
      return JSON.parse(atob(decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/')));
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------- conexión
  let despertadores = [];
  function despertar() { despertadores.splice(0).forEach((f) => f()); }

  function pausa(ms) {
    return new Promise((listo) => {
      const reloj = setTimeout(listo, ms);
      despertadores.push(() => { clearTimeout(reloj); listo(); });
    });
  }

  async function esperarVisible() {
    while (document.hidden) await pausa(60000);
  }

  const esperar = (ms, valor) => new Promise((listo) => setTimeout(() => listo(valor), ms));
  const T = { inicio: 0, enlinea: 0, alDia: 0, cache: 0 };     // tiempos (ms desde que abrió la página) para el diagnóstico del menú

  // /arranque entrega en un viaje lo que antes eran seis; con "ligera" solo se pregunta si la PC vive (volver al primer plano).
  async function probarBase(ms = 6000, ligera = false) {
    if (ES_REMOTO && !S.base) return 'sin-red';
    if (!ligera && !S.sinArranque) {
      try {
        const d = await api('/arranque', {}, ms, true);
        S.arranque = d;
        S.salud = !!d.hud;
        return 'ok';
      } catch (e) {
        if (e.status === 401) return 'token';
        if (e.status !== 404) return 'sin-red';
        S.sinArranque = true;       // puente viejo, recién actualizado Pages: sigue por /salud
      }
    }
    try {
      const d = await api('/salud', {}, 10000, true);
      S.salud = !!d.hud;
      return d.auth ? 'ok' : 'token';
    } catch (e) {
      return 'sin-red';
    }
  }

  let lecturasDeDireccion = 0;
  let proximaLectura = 0;
  let ultimaLecturaForzada = 0;

  // Al volver a primer plano o recuperar señal, el espaciado de lecturas no debe tener a la app esperando 1-2 min con la dirección nueva ya publicada.
  // Tope de una cada 30 s: GitHub da 60 lecturas por hora por IP.
  function permitirLecturaYa() {
    if (S.conectado === true || Date.now() - ultimaLecturaForzada < 30000) return;
    ultimaLecturaForzada = Date.now();
    proximaLectura = 0;
    lecturasDeDireccion = Math.min(lecturasDeDireccion, 3);
  }

  // La dirección nueva, 'token' si el sobre no abre con este token, o null si no toca leer o no se pudo.
  async function direccionPublicadaSiToca() {
    if (Date.now() < proximaLectura) return null;
    proximaLectura = Date.now() + espacioEntreLecturasS(lecturasDeDireccion++) * 1000;
    try {
      return (await leerDireccionPublicada()).url;
    } catch (e) {
      if (e.limiteGitHub) proximaLectura = Date.now() + ESPERA_SI_GITHUB_LIMITA_S * 1000;
      return e.name === 'OperationError' ? 'token' : null;
    }
  }

  async function intentarConexion() {
    if (S.sobreEnlace) {
      const sobre = S.sobreEnlace;
      S.sobreEnlace = null;
      // Un link viejo o mal pegado no debe sacar a nadie: si no abre, sigue el camino normal.
      try { ponerBase((await abrirSobre(sobre)).url); } catch (e) { /* nada */ }
    }
    const prueba = probarBase();
    let primera = await Promise.race([prueba, esperar(3000, 'lenta')]);
    let lectura = null;
    if (primera === 'lenta') {
      // La dirección guardada no contesta en 3 s: se va a buscar la nueva sin esperar el corte de la vieja.
      if (ES_REMOTO) lectura = direccionPublicadaSiToca();
      primera = await prueba;
    }
    if (primera !== 'sin-red' || !ES_REMOTO) return primera;
    const url = await (lectura || direccionPublicadaSiToca());
    if (url === 'token') return 'token';
    if (!url || url === S.base) return 'sin-red';
    ponerBase(url);
    return probarBase();
  }

  async function ponerseAlDia() {
    let d = S.arranque;
    S.arranque = null;
    if (!d) {
      // Puente sin /arranque: lo mismo, pero en paralelo y no en fila.
      const sinSerFatal = (e) => { if (e.status === 401) throw e; return null; };
      const [nov, ses, conv, apr, hue] = await Promise.all([
        api('/novedades?desde=-1', {}, 15000),
        api('/sesion').catch(sinSerFatal),
        api('/conversaciones').catch(sinSerFatal),
        api('/aprobaciones').catch(sinSerFatal),
        api('/huella').catch(sinSerFatal),
      ]);
      d = { ciclo: nov.ciclo, ultimo: nov.ultimo, sesion: ses, conversaciones: conv, aprobaciones: apr, huella: hue };
    }
    // Tras una caída breve el cursor sigue valiendo y /novedades entrega lo perdido. Solo se recarga todo si el puente reinició.
    if (d.ciclo !== S.ciclo || !S.cargado) {
      S.ciclo = d.ciclo;
      S.cursor = d.ultimo;
      if (d.sesion) {
        S.sesion = d.sesion.sesion_id;
        S.mensajes = (d.sesion.mensajes || []).map(normalizarMensaje).slice(-MAX_MENSAJES);
      }
      S.cargado = true;           // sin sesión es el HUD caído: la app igual abre, en modo sin conexión
      S.evitarRepetidos = true;     // lo que llegó entre el cursor y la sesión vendría dos veces
      pintarMensajes();
    }
    S.conversaciones = Array.isArray(d.conversaciones) ? d.conversaciones : (S.conversaciones || []);
    S.aprobaciones = d.aprobaciones?.pendientes || [];
    S.huellaRegistrada = !!d.huella?.registrada;
    pintarAprobaciones();
    pintarInicio();
    actualizarBarra();
    T.alDia = Math.round(performance.now());
    guardarCache();
    if (!S.enlaceInicialVisto) {
      S.enlaceInicialVisto = true;
      // Deep link desde una notificación: ?sesion=<id> abre ese archivo.
      const sesion = new URLSearchParams(location.search).get('sesion');
      if (sesion) {
        history.replaceState(history.state, '', location.pathname);
        verConversacion(sesion);
      }
    }
  }

  // ---------------------------------------------------------------- aprobaciones con huella
  const b64uABytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const bytesAB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const huellaDisponible = () => ES_REMOTO && !!window.PublicKeyCredential;

  function postJson(ruta, cuerpo = {}) {
    return api(ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
  }

  async function cargarAprobaciones() {
    try {
      const [a, h] = await Promise.all([api('/aprobaciones'), api('/huella')]);
      S.aprobaciones = a.pendientes || [];
      S.huellaRegistrada = !!h.registrada;
    } catch (e) {
      S.aprobaciones = [];
    }
    pintarAprobaciones();
  }

  function mensajeDeHuella(e) {
    // NotAllowedError es lo que da Android si se cancela el diálogo o vence: no es una falla del servidor.
    if (e.name === 'NotAllowedError') return 'Cancelaste la huella: no hice nada.';
    if (e.name === 'InvalidStateError') return 'Este teléfono ya tiene la huella activada.';
    return e.message || 'No pude verificar la huella.';
  }

  async function confirmarConHuella(aprobacion, boton) {
    boton.disabled = true;
    try {
      const o = await postJson(`/aprobaciones/${aprobacion.id}/opciones`);
      const firma = await navigator.credentials.get({ publicKey: {
        ...o,
        challenge: b64uABytes(o.challenge),
        allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64uABytes(c.id) })),
      } });
      const r = firma.response;
      const resultado = await postJson(`/aprobaciones/${aprobacion.id}/confirmar`, {
        id: firma.id,
        rawId: bytesAB64u(firma.rawId),
        type: firma.type,
        response: {
          clientDataJSON: bytesAB64u(r.clientDataJSON),
          authenticatorData: bytesAB64u(r.authenticatorData),
          signature: bytesAB64u(r.signature),
          userHandle: r.userHandle ? bytesAB64u(r.userHandle) : null,
        },
        clientExtensionResults: firma.getClientExtensionResults(),
      });
      if (aprobacion.tipo === TIPO_APAGAR) {
        ponerCuentaApagado(resultado.apagado_faltan_seg || 0);
        pintarPc();
      } else if (aprobacion.tipo === TIPO_RESPONDER) {
        // Contesta por el chat de Doof cuando el agente termine: aquí no hay nada que esperar en pantalla.
        avisar('Enviado. Te aviso por el chat cuando conteste.');
        await cargarAprobaciones();
        await cargarAgentes();
        return;
      } else if (aprobacion.tipo === TIPO_LLAVE) {
        await window.MiniDoof.instalar(resultado.clave);
        await cargarAprobaciones();
        avisar('Llave instalada. Ya sirve con la PC apagada.');
        await irASeccion('mini');
        return;
      } else {
        S.esperando = true;
        S.desde = Date.now();
        S.herramienta = aprobacion.tipo === TIPO_PAGO ? 'pago_aprobado' : 'mandar_whatsapp';
        irAChat();
        pintarMensajes();
      }
    } catch (e) {
      avisar(mensajeDeHuella(e));
    }
    await cargarAprobaciones();
  }

  async function cancelarAprobacion(aprobacion) {
    try {
      await postJson(`/aprobaciones/${aprobacion.id}/cancelar`);
      const avisos = { [TIPO_APAGAR]: 'Cancelado: la PC sigue prendida.', [TIPO_PAGO]: 'Cancelado: no se movió nada.', [TIPO_LLAVE]: 'Cancelado: la llave no salió de la PC.', [TIPO_RESPONDER]: 'Cancelado: no le dije nada al agente.' };
      avisar(avisos[aprobacion.tipo] || 'Cancelado: no envié nada.');
    } catch (e) {
      avisar('No pude cancelarlo: ' + e.message);
    }
    await cargarAprobaciones();
  }

  async function pedirCodigo(boton) {
    boton.disabled = true;
    try {
      await postJson('/huella/codigo');
      S.pidiendoCodigo = true;
      avisar('Te mandé el código por Telegram.');
    } catch (e) {
      avisar(e.message);
    }
    pintarAprobaciones();
  }

  async function activarHuella(codigo, boton) {
    boton.disabled = true;
    try {
      const o = await postJson('/huella/registro/opciones', { codigo });
      const nueva = await navigator.credentials.create({ publicKey: {
        ...o,
        challenge: b64uABytes(o.challenge),
        user: { ...o.user, id: b64uABytes(o.user.id) },
        excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64uABytes(c.id) })),
      } });
      const r = nueva.response;
      await postJson('/huella/registro', {
        id: nueva.id,
        rawId: bytesAB64u(nueva.rawId),
        type: nueva.type,
        response: {
          clientDataJSON: bytesAB64u(r.clientDataJSON),
          attestationObject: bytesAB64u(r.attestationObject),
          transports: r.getTransports ? r.getTransports() : [],
        },
        clientExtensionResults: nueva.getClientExtensionResults(),
      });
      S.pidiendoCodigo = false;
      avisar('Huella activada.');
    } catch (e) {
      avisar(mensajeDeHuella(e));
    }
    await cargarAprobaciones();
  }

  function botonDe(texto, alTocar, principal = false) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = texto;
    if (principal) b.className = 'principal';
    b.addEventListener('click', () => alTocar(b));
    return b;
  }

  // Todo con textContent: el mensaje y el contacto salen del modelo, y aquí se aprueba. No pueden traer HTML que cambie lo que se ve.
  function tarjetaAprobacion(aprobacion) {
    const r = aprobacion.resumen || {};
    const caja = document.createElement('section');
    caja.className = 'aprobacion';
    const titulo = document.createElement('h3');
    titulo.textContent = 'Revisa antes de enviar por WhatsApp';
    const para = document.createElement('p');
    para.className = 'para';
    para.textContent = 'Para: ' + [r.contacto, r.numero].filter(Boolean).join(' · ');
    caja.append(titulo, para);
    if (r.desde) {
      const desde = document.createElement('p');
      desde.className = 'para';
      desde.textContent = 'Desde: ' + r.desde;
      caja.append(desde);
    }
    if (r.mensaje) {
      const cuerpo = document.createElement('p');
      cuerpo.className = 'cuerpo';
      cuerpo.textContent = r.mensaje;
      caja.append(cuerpo);
    }
    if ((r.archivos || []).length) {
      const adjuntos = document.createElement('p');
      adjuntos.className = 'nota';
      adjuntos.textContent = 'Archivos: ' + r.archivos.join(', ');
      caja.append(adjuntos);
    }
    ponerAccionesDeHuella(caja, aprobacion, 'Enviar con huella', 'Para enviar desde la app, primero activa la huella en este teléfono.');
    return caja;
  }

  // Lo que se muestra viene de la pantalla de Ubii, ya comprobado por el piloto, y formateado en la PC: aquí no se hace ninguna cuenta.
  function tarjetaPago(aprobacion) {
    const r = aprobacion.resumen || {};
    const caja = document.createElement('section');
    caja.className = 'aprobacion';
    const parrafo = (clase, texto) => {
      const p = document.createElement('p');
      p.className = clase;
      p.textContent = texto;
      return p;
    };
    const titulo = document.createElement('h3');
    titulo.textContent = 'Revisa antes de pagar';
    caja.append(titulo, parrafo('monto', r.monto || ''));
    if (r.equivalente) caja.append(parrafo('dato', r.equivalente));
    caja.append(parrafo('para', 'Para: ' + (r.contacto || '')));
    [['Banco', r.banco], ['Cédula', r.documento], ['Teléfono', r.telefono]].forEach(([etiqueta, valor]) => {
      if (valor) caja.append(parrafo('dato', `${etiqueta}: ${valor}`));
    });
    if (r.nuevo) {
      caja.append(parrafo('dato aparte', r.guardar_frecuente ? 'Destinatario nuevo: queda guardado en Ubii como frecuente.' : 'Destinatario nuevo: no se guarda en Ubii.'));
    }
    if (r.comprobante) caja.append(parrafo('dato aparte', r.comprobante));
    if ((r.pantalla || []).length) {
      const detalle = document.createElement('details');
      detalle.className = 'pantalla-ubii';
      const resumen = document.createElement('summary');
      resumen.textContent = 'Lo que dice la pantalla de Ubii';
      detalle.append(resumen, parrafo('nota', r.pantalla.join('\n')));
      caja.append(detalle);
    }
    ponerAccionesDeHuella(caja, aprobacion, 'Pagar con huella', 'Para pagar desde la app, primero activa la huella en este teléfono.');
    return caja;
  }

  function tarjetaApagado(aprobacion) {
    const margen = (aprobacion.resumen || {}).margen_seg;
    const caja = document.createElement('section');
    caja.className = 'aprobacion';
    const titulo = document.createElement('h3');
    titulo.textContent = '¿Apagar la PC?';
    const cuerpo = document.createElement('p');
    cuerpo.className = 'cuerpo';
    cuerpo.textContent = `Se apaga ${margen} segundos después de aprobar. Lo que esté abierto sin guardar se pierde.`;
    const nota = document.createElement('p');
    nota.className = 'cuerpo';
    nota.textContent = 'Doof se apaga con ella: sin Telegram ni avisos, y desde la app no se puede volver a encender.';
    caja.append(titulo, cuerpo, nota);
    ponerAccionesDeHuella(caja, aprobacion, 'Apagar con huella', 'Para apagar desde la app, primero activa la huella en este teléfono.');
    return caja;
  }

  function tarjetaLlave(aprobacion) {
    const caja = document.createElement('section');
    caja.className = 'aprobacion';
    const titulo = document.createElement('h3');
    titulo.textContent = 'Instalar la llave de Charlene';
    const cuerpo = document.createElement('p');
    cuerpo.className = 'cuerpo';
    cuerpo.textContent = 'Queda guardada en este teléfono y sirve con la PC apagada. Quien tenga el teléfono desbloqueado podrá encender la PC con ella.';
    caja.append(titulo, cuerpo);
    ponerAccionesDeHuella(caja, aprobacion, 'Instalar con huella', 'Para instalarla, primero activa la huella en este teléfono.');
    return caja;
  }

  function tarjetaRespuestaAgente(aprobacion) {
    const r = aprobacion.resumen || {};
    const caja = document.createElement('section');
    caja.className = 'aprobacion';
    const titulo = document.createElement('h3');
    titulo.textContent = `Responderle a «${r.agente || 'el agente'}»`;
    const texto = document.createElement('p');
    texto.className = 'cuerpo agente-texto-a-enviar';
    texto.textContent = r.texto || '';
    const nota = document.createElement('p');
    nota.className = 'cuerpo';
    nota.textContent = 'Corre con los permisos normales de tu PC: lo que pida confirmación se niega y él te lo dirá. La terminal donde está abierto no verá este intercambio en vivo.';
    caja.append(titulo, texto, nota);
    ponerAccionesDeHuella(caja, aprobacion, 'Enviar con huella', 'Para responderle desde la app, primero activa la huella en este teléfono.');
    return caja;
  }

  function ponerAccionesDeHuella(caja, aprobacion, textoPrincipal, textoSinHuella) {
    const acciones = document.createElement('div');
    acciones.className = 'acciones';
    if (!huellaDisponible()) {
      const nota = document.createElement('p');
      nota.className = 'nota';
      nota.textContent = 'La huella solo funciona en la app instalada del teléfono.';
      caja.append(nota);
    } else if (S.huellaRegistrada) {
      acciones.append(botonDe(textoPrincipal, (b) => confirmarConHuella(aprobacion, b), true));
    } else if (S.pidiendoCodigo) {
      const campo = document.createElement('input');
      campo.id = 'codigo-huella';
      campo.placeholder = 'Código de Telegram';
      campo.autocomplete = 'one-time-code';
      campo.setAttribute('aria-label', 'Código de Telegram');
      caja.append(campo);
      acciones.append(botonDe('Activar huella', (b) => activarHuella(campo.value, b), true));
    } else {
      const nota = document.createElement('p');
      nota.className = 'nota';
      nota.textContent = textoSinHuella;
      caja.append(nota);
      acciones.append(botonDe('Activar huella', pedirCodigo, true));
    }
    acciones.append(botonDe('Cancelar', () => cancelarAprobacion(aprobacion)));
    caja.append(acciones);
  }

  const esDeOtraSeccion = (a) => a.tipo === TIPO_APAGAR || a.tipo === TIPO_LLAVE || a.tipo === TIPO_RESPONDER;

  // La de apagar vive en la sección PC: en el chat, un botón de apagar junto a lo que se escribe sería un mal toque esperando a pasar.
  function pintarAprobaciones() {
    const caja = $('#aprobaciones');
    const cajaPc = $('#pc-aprobacion');
    const escrito = $('#codigo-huella')?.value;
    const delChat = S.aprobaciones.filter((a) => !esDeOtraSeccion(a));
    caja.textContent = '';
    cajaPc.textContent = '';
    $('#agente-aprobacion').textContent = '';
    S.aprobaciones.filter((a) => a.tipo === TIPO_RESPONDER).slice(0, 1).forEach((a) => $('#agente-aprobacion').appendChild(tarjetaRespuestaAgente(a)));
    pintarResponder();
    delChat.forEach((a) => caja.appendChild(a.tipo === TIPO_PAGO ? tarjetaPago(a) : tarjetaAprobacion(a)));
    S.aprobaciones.filter((a) => a.tipo === TIPO_APAGAR).slice(0, 1).forEach((a) => cajaPc.appendChild(tarjetaApagado(a)));
    S.aprobaciones.filter((a) => a.tipo === TIPO_LLAVE).slice(0, 1).forEach((a) => cajaPc.appendChild(tarjetaLlave(a)));
    if (escrito && $('#codigo-huella')) $('#codigo-huella').value = escrito;
    if (S.vista === 'pc') pintarAccesoMini();
    caja.hidden = !delChat.length;
    document.body.classList.toggle('con-aprobacion', delChat.length > 0);     // el aviso flotante no debe tapar sus botones; la de apagar no está abajo
    if (S.vista === 'pc') pintarAccionesPc();
  }

  async function conectar() {
    if (S.conectando) return;
    S.conectando = true;
    const vuelta = ++S.vuelta;
    let intento = 0;
    T.inicio = Math.round(performance.now());
    while (vuelta === S.vuelta) {
      await esperarVisible();
      const resultado = await intentarConexion();
      if (vuelta !== S.vuelta) return;
      if (resultado === 'token') {
        mostrarLogin('Ese token no abre a Doof.');
        return;
      }
      if (resultado === 'ok') {
        lecturasDeDireccion = 0;
        proximaLectura = 0;
        // "En línea" apenas contestó la PC: el resto de la puesta al día ya no depende de ningún viaje largo.
        S.conectado = true;
        T.enlinea = Math.round(performance.now());
        actualizarEstado();
        try {
          await ponerseAlDia();
          if (vuelta !== S.vuelta) return;
          S.conectando = false;
          actualizarEstado();
          bucleNovedades(vuelta);
          cargarEstadoInicio();
          return;
        } catch (e) {
          if (e.status === 401) return;
        }
      }
      S.conectado = false;
      S.salud = false;
      actualizarEstado();
      await pausa(REINTENTOS_S[Math.min(intento, REINTENTOS_S.length - 1)] * 1000);
      intento += 1;
    }
  }

  async function bucleNovedades(vuelta) {
    while (vuelta === S.vuelta) {
      await esperarVisible();
      try {
        const d = await api(`/novedades?desde=${S.cursor}&espera=${ESPERA_NOVEDADES_S}`, {}, (ESPERA_NOVEDADES_S + 10) * 1000);
        if (vuelta !== S.vuelta) return;
        S.conectado = true;
        S.salud = !!d.hud;
        actualizarEstado();
        if (d.ciclo !== S.ciclo || d.perdidos) {
          S.ciclo = d.ciclo;
          S.cursor = d.ultimo;
          await cargarSesion();
          S.evitarRepetidos = true;
          pintarMensajes();
          pintarInicio();
          continue;
        }
        S.cursor = d.ultimo;
        d.eventos.forEach((e) => manejarEvento(e.tipo, e.datos || {}));
        if (d.eventos.length) S.evitarRepetidos = false;
      } catch (e) {
        if (vuelta !== S.vuelta || e.status === 401) return;
        if (e.status === 429) { await pausa(60000); continue; }
        conectar();
        return;
      }
    }
  }

  async function revisarAlVolver() {
    permitirLecturaYa();
    despertar();
    if (!$('#login').hidden || S.conectando) return;
    // El sistema pudo congelar la consulta abierta mientras la app estaba en segundo plano: esto no la espera.
    if ((await probarBase(6000, true)) !== 'ok') conectar();
  }

  // ---------------------------------------------------------------- estado visual
  function actualizarEstado() {
    const pill = $('#estado-pc');
    let clase = 'conectando';
    let texto = 'Conectando…';
    if (S.conectado === true && S.salud !== false) { clase = 'conectado'; texto = 'PC en línea'; }
    else if (S.conectado === false || S.salud === false) { clase = 'sin-conexion'; texto = 'PC sin conexión'; }
    pill.className = 'pastilla-estado ' + clase;
    pill.querySelector('span').textContent = texto;

    $('#barra-sub').textContent = S.vista === 'mini' ? textoConexionMini() : S.soloLectura ? 'solo lectura' : texto;

    const mostrar = (S.conectado === false || S.salud === false) && !S.soloLectura;
    $('#banda').hidden = !mostrar;
    if (mostrar) $('#banda-texto').textContent = 'PC sin conexión · reintentando…';
    $('#banda-mini').hidden = S.vista === 'mini';
    alCambiarConexionMini();
    pintarEstadoCasa();
    pintarMenuConexion();
  }

  function actualizarBarra() {
    document.body.dataset.vista = S.vista;
    $('#vista-inicio').classList.toggle('activa', S.vista === 'inicio');
    $('#vista-chat').classList.toggle('activa', S.vista === 'chat');
    $('#vista-luz').classList.toggle('activa', S.vista === 'luz');
    $('#vista-pc').classList.toggle('activa', S.vista === 'pc');
    $('#vista-usdt').classList.toggle('activa', S.vista === 'usdt');
    $('#vista-agentes').classList.toggle('activa', S.vista === 'agentes');
    $('#vista-mini').classList.toggle('activa', S.vista === 'mini');
    $('#vista-agente-p')?.classList.toggle('activa', S.vista === 'agente-p');
    $('#btn-atras').hidden = S.vista === 'inicio';
    $('#btn-nueva-barra').hidden = S.vista !== 'chat';
    $('#btn-historial').hidden = false;
    $('#barra-titulo').textContent = S.vista === 'chat' && S.soloLectura && S.inicioVista
      ? capitalizar(fechaLarga(new Date(S.inicioVista)))
      : TITULOS_DE_VISTA[S.vista] || 'Doof';
    $('#aviso-lectura').hidden = !(S.vista === 'chat' && S.soloLectura);
    actualizarEstado();
  }

  // ---------------------------------------------------------------- historial: "atrás"
  // Cada capa que tapa lo de abajo (una vista distinta de Inicio, una hoja, el visor de imagen) lleva su propia entrada en el historial y "atrás" cierra
  // solo la de arriba. Antes las hojas no apilaban nada: con el menú abierto en Inicio el gesto de Android no tenía qué retroceder y cerraba la app.
  // Debajo de todo hay una guarda ('raiz'): el primer atrás desde Inicio avisa y el segundo sale de verdad.
  // Todo cambio del historial pasa por una cola: history.back() es asíncrono y empujar justo después caía sobre la entrada equivocada.
  const H = { capas: [], ignorar: 0, alVolver: null, cola: Promise.resolve(), relojGuarda: null };
  const enCola = (f) => { H.cola = H.cola.then(f).catch(() => {}); return H.cola; };

  function guarda() {
    if (history.state?.doof === 'raiz') history.pushState({ doof: 'app' }, '');
  }

  function empujarCapa(tipo) {
    H.capas.push(tipo);
    const n = H.capas.length;
    enCola(() => { guarda(); history.pushState({ doof: 'capa', n }, ''); });
  }

  function quitarCapas(cuantas) {
    const n = Math.min(cuantas, H.capas.length);
    if (n <= 0) return Promise.resolve();
    H.capas.length -= n;
    return enCola(() => new Promise((listo) => {
      H.ignorar += 1;
      const terminar = () => {
        if (H.alVolver === terminar) { H.alVolver = null; H.ignorar = Math.max(0, H.ignorar - 1); }   // popstate no llegó: no se queda esperando
        listo();
      };
      H.alVolver = terminar;
      setTimeout(terminar, 500);
      history.go(-n);
    }));
  }

  function iniciarHistorial() {
    const e = history.state;
    if (e?.doof === 'capa') {
      // Recarga con capas apiladas: la app arranca en Inicio, así que se deshace lo que quedó encima.
      H.ignorar = 1;
      setTimeout(() => { H.ignorar = 0; }, 800);
      history.go(-(e.n || 1));
    } else if (!e?.doof) {
      history.replaceState({ doof: 'raiz' }, '');
      history.pushState({ doof: 'app' }, '');
    } else if (e.doof === 'raiz') {
      history.pushState({ doof: 'app' }, '');
    }
  }

  // El gesto o botón del sistema. El navegador ya sacó una entrada: aquí solo se cierra la capa que le correspondía.
  function alGestoAtras() {
    if (H.ignorar > 0) {
      H.ignorar -= 1;
      const f = H.alVolver;
      H.alVolver = null;
      if (f) f();
      return;
    }
    if (history.state?.doof === 'raiz') {
      H.capas.length = 0;
      cerrarVisorUI();
      cerrarHojasUI();
      if (S.vista !== 'inicio') irAInicioUI();
      avisar('Atrás otra vez para salir');
      clearTimeout(H.relojGuarda);
      H.relojGuarda = setTimeout(() => enCola(guarda), 2600);
      return;
    }
    const capa = H.capas.pop();
    if (capa === 'visor') cerrarVisorUI();
    else if (capa === 'hoja') cerrarHojasUI();
    else if (capa === 'vista') volverUI();
  }

  // Lo mismo, pedido por la barra o por Escape: aquí sí hay que sacar la entrada del historial.
  function atras() {
    const tope = H.capas[H.capas.length - 1];
    if (tope === 'visor') cerrarVisor();
    else if (tope === 'hoja') cerrarHojas();
    else if (S.vista !== 'inicio') volver();
  }

  function irAInicioUI() {
    if (S.vista === 'inicio') return;
    S.vista = 'inicio';
    actualizarBarra();
    cerrarHojasUI();
    pintarInicio();
    cargarEstadoInicio();
  }

  function irAInicio() {
    cerrarVisorUI();
    cerrarHojasUI();
    irAInicioUI();
    quitarCapas(H.capas.length);
  }

  // Entre vistas no se apilan entradas: la capa 'vista' es una sola y "atrás" siempre vuelve al inicio.
  function entrarAVista(vista) {
    cerrarHojas();
    S.vista = vista;
    actualizarBarra();
    if (!H.capas.includes('vista')) empujarCapa('vista');
  }

  function irAChat() {
    if (S.vista !== 'chat') entrarAVista('chat');
    pintarMensajes();
    setTimeout(() => alFinal(true), 30);
  }

  async function irASeccion(vista) {
    cerrarHojas();
    if (S.soloLectura) await volverActiva(false);
    if (S.vista !== vista) entrarAVista(vista);
    pintarAprobaciones();
    if (vista === 'luz') pintarLuz();
    else if (vista === 'usdt') pintarUsdt();
    else if (vista === 'agentes') pintarAgentes();
    else if (vista === 'mini') abrirMini();
    else if (vista === 'agente-p') abrirAgenteP();
    else { pintarPc(); pintarAccesoMini(); }
    $('#vista-' + vista).scrollTop = 0;
    refrescarSeccion();
  }

  async function irAlChatDesdeElMenu() {
    if (S.soloLectura) await volverActiva(true);
    else irAChat();
  }

  function alElegirDelMenu(destino) {
    if (destino === 'conversaciones') { abrirHoja('hoja-historial'); return; }     // una hoja reemplaza a la otra: no apila entradas
    cerrarHojas();
    if (destino === 'inicio') {
      if (S.soloLectura) volverActiva(false);
      else irAInicio();
    } else if (destino === 'chat') irAlChatDesdeElMenu();
    else irASeccion(destino);
  }

  async function volverActiva(abrirChat = false) {
    S.soloLectura = false;
    S.inicioVista = null;
    S.sesionVista = null;
    try {
      await cargarSesion();
    } catch (e) {
      if (e.status === 401) return;
    }
    S.vista = abrirChat ? 'chat' : 'inicio';
    actualizarBarra();
    pintarMensajes();
    pintarInicio();
    if (abrirChat) {
      if (!H.capas.includes('vista')) empujarCapa('vista');
      setTimeout(() => alFinal(true), 30);
    } else {
      quitarCapas(H.capas.length);
      cargarEstadoInicio();
    }
  }

  function volverUI() {
    if (S.soloLectura) volverActiva(false);
    else irAInicioUI();
  }

  function volver() {
    if (S.soloLectura) volverActiva(false);
    else irAInicio();
  }

  // ---------------------------------------------------------------- agentes
  // Doof lista las sesiones de agentes de terminal de la PC y lo que dejaron. Responderles pasa por la huella (tarjeta TIPO_RESPONDER): el agente tiene
  // permisos sobre la PC. El aviso de "terminó" y su respuesta llegan como un mensaje más de Doof por el chat, así que no hay nada que escuchar aparte.
  const REFRESCO_AGENTES_MS = 8000;
  const A = { lista: null, falla: null, abierto: null, detalle: null, detalleFalla: null, leida: null };

  async function cargarAgentes() {
    try {
      A.lista = await api('/agentes');
      A.falla = null;
      A.leida = new Date();
      if (A.abierto) {
        try {
          A.detalle = await api('/agentes/' + encodeURIComponent(A.abierto));
          A.detalleFalla = null;
        } catch (e) {
          if (e.status === 401) return;
          A.detalleFalla = e;     // 404: la sesión se cerró mientras se miraba
        }
      }
    } catch (e) {
      if (e.status === 401) return;
      A.lista = null;             // una lista vieja haría creer que un agente sigue trabajando
      A.falla = e;
    }
    if (S.vista === 'agentes') pintarAgentes();
    else if (S.vista === 'inicio') pintarEstadoCasa();
    guardarCache();
  }

  // Lo que escribe un agente viene en Markdown (títulos, listas, **negritas**, `código`). Se pinta con nodos DOM y textContent, nunca con innerHTML:
  // el texto sale de una sesión con permisos sobre la PC y no debe poder inyectar HTML en la app. Solo los casos que de verdad escriben.
  function mdEnLinea(padre, texto) {
    const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\s][^*\n]*\*)/g;
    let ultimo = 0, m;
    while ((m = re.exec(texto))) {
      if (m.index > ultimo) padre.append(texto.slice(ultimo, m.index));
      const t = m[0];
      if (t.startsWith('**')) padre.append(elemento('strong', '', t.slice(2, -2)));
      else if (t.startsWith('`')) padre.append(elemento('code', '', t.slice(1, -1)));
      else padre.append(elemento('em', '', t.slice(1, -1)));
      ultimo = m.index + t.length;
    }
    if (ultimo < texto.length) padre.append(texto.slice(ultimo));
  }

  function renderMarkdown(texto) {
    const raiz = elemento('div', 'md');
    const lineas = String(texto || '').replace(/\r\n?/g, '\n').split('\n');
    let lista = null, parrafo = null, codigo = null;
    const cerrar = () => { lista = null; parrafo = null; };
    for (const linea of lineas) {
      if (/^\s*```/.test(linea)) {                       // la fence abre y cierra un bloque de código
        if (codigo) { raiz.append(codigo.pre); codigo = null; } else { cerrar(); codigo = { pre: elemento('pre', 'md-codigo'), lineas: [] }; }
        continue;
      }
      if (codigo) { codigo.lineas.push(linea); codigo.pre.textContent = codigo.lineas.join('\n'); continue; }
      let m;
      if (!linea.trim()) { cerrar(); continue; }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(linea))) {
        cerrar();
        const h = elemento('p', 'md-titulo n' + Math.min(m[1].length, 3));
        mdEnLinea(h, m[2]);
        raiz.append(h);
      } else if ((m = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(linea))) {
        const ordenada = /\d/.test(m[1]);
        if (!lista || lista.ordenada !== ordenada) {
          parrafo = null;
          lista = { ordenada, el: elemento(ordenada ? 'ol' : 'ul', 'md-lista') };
          raiz.append(lista.el);
        }
        const li = elemento('li', '');
        mdEnLinea(li, m[2]);
        lista.el.append(li);
      } else {
        lista = null;
        if (!parrafo) { parrafo = elemento('p', 'md-parrafo'); raiz.append(parrafo); }
        else parrafo.append(document.createElement('br'));
        mdEnLinea(parrafo, linea.trim());
      }
    }
    if (codigo) raiz.append(codigo.pre);                 // una fence sin cerrar (el texto se recorta) igual se muestra
    return raiz;
  }

  // El campo vive fuera de #agentes-contenido y se crea una sola vez: ese contenedor se repinta cada 8 s, y repintar un textarea borraría lo que
  // Javier está escribiendo y le quitaría el teclado.
  function pintarResponder() {
    const caja = $('#agente-responder');
    if (!caja) return;
    const d = S.vista === 'agentes' && A.abierto && !A.detalleFalla ? A.detalle : null;
    const esperandoHuella = S.aprobaciones.some((a) => a.tipo === TIPO_RESPONDER);
    caja.hidden = !d || esperandoHuella;
    if (caja.hidden) return;
    if (!A.campo) {
      A.campo = elemento('textarea', 'agente-campo');
      A.campo.rows = 3;
      A.campo.maxLength = MAX_RESPUESTA_AGENTE;
      A.campo.setAttribute('aria-label', 'Respuesta para el agente');
      A.campo.placeholder = 'Respóndele a este agente…';
      A.nota = elemento('p', 'casa-nota');
      A.boton = botonDe('Responder', pedirRespuestaAgente, true);
      caja.append(A.campo, A.boton, A.nota);
    }
    if (A.campoPara !== A.abierto) { A.campo.value = ''; A.campoPara = A.abierto; }     // el borrador de un agente no se le manda a otro
    A.campo.disabled = !d.puede_responder;
    A.boton.disabled = !d.puede_responder;
    A.nota.textContent = d.puede_responder
      ? 'Te pide la huella antes de enviarle nada. Su respuesta te llega por el chat.'
      : d.agente !== 'claude_code' ? 'A este agente solo se le puede leer.' : 'Sigue trabajando: podrás responderle cuando termine.';
  }

  async function pedirRespuestaAgente(boton) {
    const texto = A.campo.value.trim();
    if (!texto) { avisar('Escribe qué le quieres decir.'); return; }
    boton.disabled = true;
    try {
      await postJson(`/agentes/${encodeURIComponent(A.abierto)}/responder`, { texto });
      A.campo.value = '';
      await cargarAprobaciones();      // deja la tarjeta con la huella y esconde el campo
    } catch (e) {
      avisar(e.message || 'No pude preparar la respuesta.');
    }
    boton.disabled = false;
  }

  function filaAgente(a) {
    const b = elemento('button', 'agente-fila' + (a.estado === 'trabajando' ? ' trabajando' : ''));
    b.type = 'button';
    const texto = elemento('span', 'agente-texto');
    texto.append(elemento('b', '', a.nombre), elemento('small', '', `${a.proyecto} · ${a.estado === 'trabajando' ? 'trabajando desde' : 'libre desde'} ${a.hace}`));
    b.append(elemento('i', 'agente-punto'), texto);
    b.addEventListener('click', () => { A.abierto = a.id; A.detalle = null; A.detalleFalla = null; pintarAgentes(); cargarAgentes(); });
    return b;
  }

  function pintarDetalleAgente(caja) {
    caja.appendChild(botonCasa('‹ Todos los agentes', '', () => { A.abierto = null; pintarAgentes(); }));
    const d = A.detalle;
    if (A.detalleFalla) {
      caja.appendChild(encabezadoCasa('', 'Esa sesión ya no está', 'Se cerró mientras la mirabas.'));
      return;
    }
    if (!d) {
      caja.appendChild(encabezadoCasa('', 'Leyendo la sesión…'));
      return;
    }
    const trabajando = d.estado === 'trabajando';
    caja.appendChild(encabezadoCasa(trabajando ? 'alerta' : 'bien', d.nombre, `${d.proyecto} · ${trabajando ? 'trabajando desde' : 'libre desde'} ${d.hace}`));
    if (d.titulo || d.pedido) {
      caja.appendChild(elemento('p', 'casa-subtitulo', 'Lo último que le pidieron'));
      caja.appendChild(elemento('p', 'agente-pedido', d.pedido || d.titulo));
    }
    caja.appendChild(elemento('p', 'casa-subtitulo', trabajando ? 'Lo que lleva dicho' : 'Lo que dejó'));
    const resultado = elemento('div', 'agente-resultado');
    if (d.resultado) resultado.append(renderMarkdown(d.resultado));
    else resultado.textContent = trabajando ? 'Sigue en eso: todavía no ha escrito nada que mostrar.' : 'No dejó ningún texto.';
    caja.appendChild(resultado);
    if (d.mensajes && d.mensajes.length > 1) {
      const mas = elemento('details', 'agente-mas');
      mas.append(elemento('summary', '', `Mensajes anteriores del turno (${d.mensajes.length - 1})`));
      for (const m of d.mensajes.slice(0, -1)) { const c = elemento('div', 'agente-resultado'); c.append(renderMarkdown(m)); mas.append(c); }
      caja.appendChild(mas);
    }
  }

  function pintarAgentes() {
    const caja = $('#agentes-contenido');
    caja.replaceChildren();
    if (A.abierto) {
      pintarDetalleAgente(caja);
    } else if (A.falla) {
      caja.appendChild(encabezadoCasa('mal', 'No llego a los agentes', textoDeFalla(A.falla)));
    } else if (!A.lista) {
      caja.appendChild(encabezadoCasa('', 'Preguntándole a la PC…'));
    } else if (!A.lista.sesiones.length) {
      caja.appendChild(encabezadoCasa('', 'No hay agentes abiertos', 'Cuando abras una sesión de Claude Code en la PC aparecerá aquí.'));
    } else {
      const n = A.lista.trabajando;
      caja.appendChild(encabezadoCasa(n ? 'alerta' : 'bien', n ? `${n} trabajando` : 'Todos libres', n ? 'Te aviso por el chat cuando termine cada uno.' : 'Ninguno está ocupado ahora.'));
      const lista = elemento('div', 'agentes-lista');
      for (const a of A.lista.sesiones) lista.appendChild(filaAgente(a));
      caja.appendChild(lista);
    }
    if (A.leida && !A.abierto) caja.appendChild(elemento('p', 'casa-nota', `Leído a las ${hora(A.leida)}. Toca uno para ver lo que dejó y responderle.`));
    pintarResponder();
  }

  // ---------------------------------------------------------------- USDT
  // Doof ya trae el precio, la brecha, la tendencia y los textos: aquí solo se pinta (y se escala la gráfica). El modo vigía es un interruptor:
  // el aviso de caída llega como un mensaje más de Doof por el chat, así que no hay nada que escuchar aparte.
  const REFRESCO_USDT_MS = 20000;
  const U = { datos: null, falla: null, leida: null, cambiando: false, falloModo: null };

  // 1045.5 -> "1.046" ; 16.43 con 1 decimal -> "16,4": punto de miles y coma decimal, como se escribe aquí.
  function bs(n, dec = 0) {
    const [entero, fraccion] = Math.abs(n).toFixed(dec).split('.');
    return (n < 0 ? '-' : '') + entero.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (fraccion ? ',' + fraccion : '');
  }
  const conSigno = (n, dec = 1) => (n > 0 ? '+' : '') + bs(n, dec);

  async function cargarUsdt() {
    try {
      U.datos = await api('/usdt', {}, TIEMPO_LUZ_MS);
      U.falla = null;
      U.leida = new Date();
    } catch (e) {
      if (e.status === 401) return;
      U.datos = null;         // un precio viejo se leería como el de ahora
      U.falla = e;
    }
    if (S.vista === 'usdt') pintarUsdt();
  }

  async function cambiarModoUsdt(activo) {
    U.cambiando = true;
    U.falloModo = null;
    pintarUsdt();
    try {
      U.datos = await api('/usdt/modo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activo }) }, TIEMPO_LUZ_MS);
      U.falla = null;
      U.leida = new Date();
    } catch (e) {
      if (e.status === 401) return;
      U.falloModo = textoDeFalla(e);    // el interruptor queda como estaba: no se pinta un estado que no se confirmó
    } finally {
      U.cambiando = false;
    }
    if (S.vista === 'usdt') pintarUsdt();
  }

  function encabezadoUsdt() {
    const d = U.datos;
    if (U.falla) return encabezadoCasa('', 'No sé cómo está el USDT', textoDeFalla(U.falla));
    if (!d) return encabezadoCasa('', 'Mirando el USDT…', '');
    if (d.estado === 'sin_datos') return encabezadoCasa('', 'No veo el precio del USDT', d.error || 'Binance P2P no respondió.');
    const p = d.precio;
    const clase = d.tendencia.direccion === 'baja' ? 'mal' : d.tendencia.direccion === 'sube' ? 'bien' : '';
    const brecha = p.brecha_pct === null ? 'Sin el BCV de hoy, no hay brecha.' : `Brecha de ${bs(p.brecha_pct, 1)} % sobre el BCV.`;
    const viejo = d.estado === 'viejo' ? ` Dato de hace ${p.hace}: ahora no logro leer Binance.` : '';
    return encabezadoCasa(clase, `${bs(p.usdt)} Bs`, brecha + viejo);
  }

  function nodoModoUsdt(d) {
    const caja = elemento('div', 'usdt-modo');
    const activo = d.modo.activo;
    const boton = elemento('button', 'usdt-interruptor' + (activo ? ' activo' : ''));
    boton.type = 'button';
    boton.setAttribute('role', 'switch');
    boton.setAttribute('aria-checked', String(activo));
    boton.disabled = U.cambiando;
    const texto = elemento('span', 'usdt-interruptor-texto');
    texto.append(elemento('b', '', 'Vigía de caídas'), elemento('small', '', U.cambiando ? 'Un momento…' : activo ? `Activo${d.modo.desde ? ' desde ' + d.modo.desde : ''}` : 'Apagado'));
    boton.append(texto, elemento('i', 'usdt-palanca'));
    boton.addEventListener('click', () => cambiarModoUsdt(!activo));
    caja.append(boton);
    caja.append(elemento('p', 'casa-nota', activo
      ? `Doof lee el precio cada 5 minutos y te avisa por Telegram y por aquí si el USDT cae ${bs(d.umbrales.caida_pct, 1)} % en una hora, o si la brecha con el BCV baja ${bs(d.umbrales.brecha_pp, 1)} puntos en 6 horas.`
      : 'Apagado, Doof no lee nada en segundo plano ni te avisa. Aquí abajo ves el precio de ahora, pero sin historia.'));
    if (U.falloModo) caja.append(elemento('p', 'casa-nota usdt-error', 'No pude cambiar el modo: ' + U.falloModo));
    return caja;
  }

  function nodoTendenciaUsdt(t) {
    const caja = elemento('div', 'usdt-tendencia');
    caja.append(elemento('h3', 'casa-subtitulo', 'Hacia dónde va'));
    caja.append(elemento('p', 'usdt-tendencia-texto', t.texto));
    const c = t.cambios || {};
    const filas = [['1 hora', c['1h']], ['6 horas', c['6h']], ['24 horas', c['24h']]]
      .map(([nombre, v]) => [nombre, v === null || v === undefined ? '—' : `${conSigno(v, 2)} %`]);
    caja.append(lecturas(filas));
    if (t.confianza) caja.append(elemento('p', 'casa-nota', `Confianza de la estimación: ${t.confianza}. Sale de las últimas 3 horas de lecturas y no sabe nada de lo que haga el BCV.`));
    return caja;
  }

  function nodoGraficaUsdt(puntos) {
    const caja = elemento('div', 'usdt-grafica-caja');
    if (!puntos || puntos.length < 2) {
      caja.append(elemento('p', 'casa-nota', 'Todavía no hay lecturas guardadas para dibujar. Con el vigía activo se juntan solas.'));
      return caja;
    }
    const NS = 'http://www.w3.org/2000/svg';
    const W = 300, H = 90, P = 4;
    const precios = puntos.map((p) => p.usdt);
    const min = Math.min(...precios), max = Math.max(...precios);
    const rango = Math.max(max - min, 1);
    const viejo = Math.max(...puntos.map((p) => p.hace_min), 1);
    const xy = (p) => [P + (1 - p.hace_min / viejo) * (W - 2 * P), P + (1 - (p.usdt - min) / rango) * (H - 2 * P)];
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'usdt-grafica');
    svg.setAttribute('role', 'img');
    const horas = viejo >= 90 ? `${Math.round(viejo / 60)} horas` : `${viejo} minutos`;
    svg.setAttribute('aria-label', `Precio del USDT en las últimas ${horas}: entre ${bs(min)} y ${bs(max)} bolívares.`);
    const linea = document.createElementNS(NS, 'polyline');
    linea.setAttribute('points', puntos.map((p) => xy(p).map((v) => v.toFixed(1)).join(',')).join(' '));
    svg.append(linea);
    const [ux, uy] = xy(puntos[puntos.length - 1]);
    const punto = document.createElementNS(NS, 'circle');
    punto.setAttribute('cx', ux.toFixed(1));
    punto.setAttribute('cy', uy.toFixed(1));
    punto.setAttribute('r', '3');
    svg.append(punto);
    caja.append(elemento('h3', 'casa-subtitulo', `Últimas ${horas}`), svg, elemento('p', 'casa-nota', `Mínimo ${bs(min)} Bs · máximo ${bs(max)} Bs`));
    return caja;
  }

  function pintarUsdt() {
    const caja = $('#usdt-contenido');
    caja.textContent = '';
    caja.appendChild(encabezadoUsdt());
    const d = U.datos;
    if (!d) return;
    if (d.estado !== 'sin_datos' && d.precio) {
      const p = d.precio;
      const sin = (v, dec = 0) => (v === null || v === undefined ? '—' : bs(v, dec));
      // "Vender" solo si hay: los anuncios de compra de USDT alcanzables para una persona escasean (los mejor pagados piden mínimos de millones de Bs).
      const pares = [['USDT', sin(p.usdt)], ['BCV', sin(p.bcv, 2)]];
      if (p.venta !== null && p.venta !== undefined) pares.splice(1, 0, ['Vender', sin(p.venta)]);
      caja.append(lecturas(pares));
    }
    caja.append(nodoModoUsdt(d));
    if (d.tendencia) {
      caja.append(nodoTendenciaUsdt(d.tendencia));
      caja.append(nodoGraficaUsdt(d.grafica));
    }
    if (d.avisos?.length) {
      caja.append(elemento('h3', 'casa-subtitulo', 'Últimos avisos'));
      for (const a of d.avisos) {
        const fila = elemento('div', 'usdt-aviso');
        fila.append(elemento('small', '', a.cuando), elemento('p', '', a.texto));
        caja.append(fila);
      }
    }
    const partes = ['Precio de Binance P2P (mediana de los mejores anuncios con USDT de sobra y vendedores confiables), contra la tasa oficial del BCV.'];
    if (U.leida) partes.push(`Leído a las ${hora(U.leida)}.`);
    caja.append(elemento('p', 'casa-nota', partes.join(' ')));
  }

  // ---------------------------------------------------------------- luz y PC
  // Todo llega resuelto de Doof: aquí no se decide si hay luz ni se calcula nada, solo se pinta.
  async function refrescarSeccion() {
    const turno = ++S.turnoSeccion;
    const vista = S.vista;
    if (vista !== 'luz' && vista !== 'pc' && vista !== 'agentes' && vista !== 'usdt') return;
    if (!document.hidden) await (vista === 'luz' ? cargarLuz() : vista === 'agentes' ? cargarAgentes() : vista === 'usdt' ? cargarUsdt() : cargarPc());
    if (turno !== S.turnoSeccion || S.vista !== vista) return;
    await pausa(vista === 'luz' ? REFRESCO_LUZ_MS : vista === 'agentes' ? REFRESCO_AGENTES_MS : vista === 'usdt' ? REFRESCO_USDT_MS : REFRESCO_PC_MS);
    if (turno === S.turnoSeccion) refrescarSeccion();
  }

  function elemento(etiqueta, clase, texto) {
    const n = document.createElement(etiqueta);
    if (clase) n.className = clase;
    if (texto !== undefined) n.textContent = texto;
    return n;
  }

  function encabezadoCasa(clase, titulo, detalle) {
    const caja = elemento('div', 'casa ' + clase);
    const h2 = elemento('h2', '', titulo);
    h2.id = 'casa-titulo-' + S.vista;
    caja.append(elemento('i'), h2);
    if (detalle) caja.append(elemento('p', '', detalle));
    return caja;
  }

  function textoDeFalla(e) {
    // Con el túnel caído, Cloudflare contesta 530 sin JSON: "error 530" no le dice nada a nadie.
    if (e.sinRed || (e.status >= 500 && /^error \d+$/.test(e.message))) return 'No llego a la PC. Puede estar apagada o sin internet: desde aquí no se distingue.';
    if (e.status === 404) return 'Falta reiniciar Doof en la PC para activar esta sección.';
    return e.message;
  }

  const decimal = (n) => String(n).replace('.', ',');

  function lecturas(pares) {
    const lista = elemento('dl', 'lecturas');
    for (const [nombre, valor] of pares) {
      const fila = elemento('div');
      fila.append(elemento('dt', '', nombre), elemento('dd', '', valor));
      lista.appendChild(fila);
    }
    return lista;
  }

  async function cargarLuz() {
    try {
      S.luz = await api('/luz', {}, TIEMPO_LUZ_MS);
      S.luzFalla = null;
      S.luzLeida = new Date();
    } catch (e) {
      if (e.status === 401) return;
      S.luz = null;       // una lectura vieja haría creer que todavía se sabe cómo está la casa
      S.luzFalla = e;
    }
    if (S.vista === 'luz') pintarLuz();
    else if (S.vista === 'inicio') pintarEstadoCasa();
    guardarCache();
  }

  function encabezadoLuz() {
    const d = S.luz;
    if (S.luzFalla) return encabezadoCasa('', 'No sé si hay luz', textoDeFalla(S.luzFalla));
    if (!d) return encabezadoCasa('', 'Mirando las baterías…');
    if (d.estado === 'sin_respuesta' && d.falta_clave) return encabezadoCasa('', 'No sé si hay luz', 'A Doof le falta la contraseña del panel de Baterías para leer lo que publica la Raspberry.');
    if (d.estado === 'sin_respuesta') {
      const u = d.ultimo;
      const ultimo = u ? ` Último dato hace ${u.hace}${u.soc_pct === null ? '' : `: batería al ${u.soc_pct} %`}.` : '';
      return encabezadoCasa('', 'No sé si hay luz', 'No llegan datos recientes de la Raspberry: se reinicia con cada corte, o puede estar sin internet.' + ultimo);
    }
    if (d.estado === 'bms_desconectado') return encabezadoCasa('', 'No sé si hay luz', 'La Raspberry responde, pero no está leyendo el BMS de las baterías.');
    if (d.estado === 'sin_luz') {
      const corte = d.corte_actual;
      return encabezadoCasa('mal', 'Sin luz', corte ? `Desde ${corte.desde} · lleva ${corte.dura}` : 'Las baterías están sosteniendo la casa.');
    }
    const sentido = { cargando: 'Las baterías están cargando.', descargando: 'Las baterías descargan un momento, sin corte confirmado.', reposo: 'Las baterías están en reposo.' };
    return encabezadoCasa('bien', 'Hay luz', sentido[d.bateria?.sentido]);
  }

  function nodoBateria(b) {
    const caja = elemento('div', 'bateria');
    const cab = elemento('div', 'bateria-cab');
    cab.append(elemento('b', '', b.soc_pct === null ? 'Batería sin dato' : `${b.soc_pct} %`));
    if (b.restante) cab.append(elemento('small', '', `${b.restante.etiqueta} ${b.restante.texto}`.trim()));
    caja.append(cab);
    if (b.soc_pct !== null) {
      const medidor = elemento('div', 'medidor' + (b.soc_pct <= 15 ? ' bajo' : b.soc_pct <= 35 ? ' medio' : ''));
      const relleno = elemento('span');
      relleno.style.width = Math.min(100, Math.max(0, b.soc_pct)) + '%';
      medidor.appendChild(relleno);
      caja.append(medidor);
    }
    return caja;
  }

  function pintarLuz() {
    const caja = $('#luz-contenido');
    caja.textContent = '';
    caja.appendChild(encabezadoLuz());
    const d = S.luz;
    if (!d || !d.bateria) return;
    const b = d.bateria;
    caja.append(nodoBateria(b));
    const sinDato = (v, unidad) => (v === null || v === undefined ? '—' : `${decimal(v)} ${unidad}`);
    caja.append(lecturas([['Potencia', sinDato(b.potencia_w, 'W')], ['Voltaje', sinDato(b.voltaje_v, 'V')], ['Temperatura', sinDato(b.temperatura_c, '°C')]]));
    if (d.cortes?.length) {
      caja.append(elemento('h3', 'casa-subtitulo', 'Últimos cortes'));
      for (const c of d.cortes) {
        const fila = elemento('div', 'corte');
        fila.append(elemento('span', '', c.inicio), elemento('small', '', c.potencia_w ? `${c.dura} · ${c.potencia_w} W` : c.dura));
        caja.append(fila);
      }
    }
    const partes = [];
    if (d.totales) partes.push(`${d.totales.cortes} ${d.totales.cortes === 1 ? 'corte' : 'cortes'} y ${decimal(d.totales.horas)} h con las baterías en total.`);
    if (S.luzLeida) partes.push(`Leído a las ${hora(S.luzLeida)}.`);
    if (partes.length) caja.append(elemento('p', 'casa-nota', partes.join(' ')));
  }

  function ponerCuentaApagado(segundos) {
    S.apagadoHasta = segundos > 0 ? Date.now() + segundos * 1000 : 0;
  }

  const segundosParaApagar = () => Math.max(0, Math.ceil((S.apagadoHasta - Date.now()) / 1000));

  async function cargarPc() {
    try {
      S.pc = await api('/pc');
      S.pcFalla = null;
      S.pcLeida = new Date();
      const faltan = S.pc.apagado_faltan_seg || 0;
      if (faltan > 0) ponerCuentaApagado(faltan);
      // Si faltaba y ya no: lo cancelaron desde otro lado. Si ya pasó la hora, se está apagando, salvo que pase demasiado.
      else if (segundosParaApagar() > 0 || Date.now() - S.apagadoHasta > APAGANDO_COMO_MAXIMO_MS) S.apagadoHasta = 0;
    } catch (e) {
      if (e.status === 401) return;
      S.pc = null;
      S.pcFalla = e;
    }
    if (S.vista === 'pc') pintarPc();
    else if (S.vista === 'inicio') pintarEstadoCasa();
    guardarCache();
  }

  function textoCuenta() {
    const faltan = segundosParaApagar();
    return faltan > 0 ? `Se apaga en ${faltan} s` : 'Apagándose…';
  }

  let relojCuenta = null;
  function pintarPc() {
    const caja = $('#pc-datos');
    caja.textContent = '';
    clearInterval(relojCuenta);
    if (S.apagadoHasta && Date.now() - S.apagadoHasta > APAGANDO_COMO_MAXIMO_MS) S.apagadoHasta = 0;
    if (S.apagadoHasta) {
      caja.appendChild(encabezadoCasa('alerta', textoCuenta(), 'Lo que esté abierto se va a cerrar.'));
      relojCuenta = setInterval(() => {
        const titulo = $('#casa-titulo-pc');
        if (titulo) titulo.textContent = textoCuenta();
        if (!segundosParaApagar()) { clearInterval(relojCuenta); pintarAccionesPc(); }
      }, 1000);
    } else if (S.pcFalla) {
      caja.appendChild(encabezadoCasa('mal', 'No responde', textoDeFalla(S.pcFalla)));
    } else if (!S.pc) {
      caja.appendChild(encabezadoCasa('', 'Preguntándole a la PC…'));
    } else {
      caja.appendChild(encabezadoCasa('bien', 'Encendida', `Desde hace ${S.pc.encendida_hace}`));
    }
    if (S.pc && !S.pcFalla) caja.appendChild(lecturas([['CPU', `${S.pc.cpu} %`], ['Memoria', `${S.pc.ram} %`]]));
    pintarAccionesPc();
  }

  function botonCasa(texto, clase, alTocar) {
    const b = elemento('button', 'accion-casa' + (clase ? ' ' + clase : ''), texto);
    b.type = 'button';
    if (alTocar) b.addEventListener('click', () => alTocar(b));
    return b;
  }

  async function pedirApagado(boton) {
    boton.disabled = true;
    try {
      await postJson('/pc/apagar');
      await cargarAprobaciones();
    } catch (e) {
      boton.disabled = false;
      avisar(e.status === 404 ? 'Falta reiniciar Doof en la PC.' : 'No pude pedirlo: ' + e.message);
    }
  }

  async function cancelarApagado(boton) {
    boton.disabled = true;
    try {
      const d = await postJson('/pc/cancelar-apagado');
      S.apagadoHasta = 0;
      avisar(d.ok ? 'Apagado cancelado. La PC sigue prendida.' : 'Windows ya no tenía nada programado.');
    } catch (e) {
      avisar('No pude cancelarlo: ' + e.message);
    }
    await cargarPc();
    pintarPc();
  }

  function pintarAccionesPc() {
    const caja = $('#pc-acciones');
    caja.textContent = '';
    const tarjetaAbierta = S.aprobaciones.some((a) => a.tipo === TIPO_APAGAR);
    if (S.apagadoHasta) {
      if (segundosParaApagar() > 0) caja.append(botonCasa('Cancelar el apagado', '', cancelarApagado));
    } else if (S.pc && !S.pcFalla && !tarjetaAbierta) {
      caja.append(botonCasa('Apagar la PC', 'peligro', pedirApagado));
    }
  }

  // ---------------------------------------------------------------- Charlene
  // Vive en la Raspberry y contesta aunque la PC esté apagada: nada de aquí pasa por el puente, salvo instalar la llave. Lo que dice la Pi se pinta con textContent.
  // Los botones los decide ella: aquí solo se ordenan por tema, y un id que no esté en esta lista cae en el último grupo, así que uno nuevo aparece solo.
  const GRUPOS_MINI = [
    ['PC', ['estado_pc', 'encender']],
    ['Casa', ['luz', 'autonomia', 'cortes']],
    ['Agenda', ['horario', 'notas']],
    ['Charlene', ['estado_doof', 'reinicios', 'modo_seguro', 'modo_normal']],
  ];
  const CLAVE_MENU_MINI = 'mini_doof_menu';
  const MINI_NO_RESPONDE = 'No me llega nada de la Raspberry. Se reinicia cada vez que cambia entre baterías y calle: prueba otra vez en un par de minutos.';
  const SALUDO_MINI = 'Soy Charlene. Vivo en la Raspberry, así que contesto aunque la PC esté apagada. Los botones leen datos reales; si me escribes, respondo con lo que sé y puedo equivocarme.';
  const TEXTO_CONEXION_MINI = { buscando: 'Buscando la Raspberry…', lista: 'Raspberry en línea', caida: 'La Raspberry no responde' };

  function menuGuardadoMini() {
    try { return JSON.parse(localStorage.getItem(CLAVE_MENU_MINI)) || null; } catch (e) { return null; }
  }

  const mini = { mensajes: [], menu: menuGuardadoMini(), menuAlDia: false, grupo: 'PC', ocupado: false, confirmando: null, conexion: '', sinPc: false, relojAbrir: null, relojOcultar: null };

  const pcCaida = () => S.conectado === false || !!S.pcFalla;
  const textoConexionMini = () => TEXTO_CONEXION_MINI[mini.conexion] || '';

  function alCambiarConexionMini() {
    const caida = pcCaida();
    if (caida === mini.sinPc) return;
    mini.sinPc = caida;
    clearTimeout(mini.relojAbrir);
    if (caida) {
      mini.grupo = 'PC';
      // Con margen: un corte de segundos del túnel no debe sacar a nadie de la sección PC.
      mini.relojAbrir = setTimeout(() => {
        if (pcCaida() && S.vista === 'pc' && window.MiniDoof.instalada()) irASeccion('mini');
      }, ESPERA_ABRIR_MINI_MS);
    }
    if (S.vista === 'pc') pintarAccesoMini();
    if (S.vista === 'mini') pintarAccionesMini();
  }

  async function pedirLlaveMini(boton) {
    boton.disabled = true;
    try {
      await postJson('/mini-doof/pedir-llave');
      await irASeccion('pc');
      await cargarAprobaciones();
      pintarAccesoMini();
    } catch (e) {
      boton.disabled = false;
      avisar(e.status === 404 ? 'Falta reiniciar Doof en la PC.' : 'No pude pedirla: ' + e.message);
    }
  }

  // ---- en la sección PC: solo el acceso
  function pintarAccesoMini() {
    const caja = $('#pc-mini-doof');
    caja.textContent = '';
    caja.append(elemento('h3', 'mini-titulo', 'Charlene'));
    const pedida = S.aprobaciones.some((a) => a.tipo === TIPO_LLAVE);
    if (window.MiniDoof.instalada()) {
      caja.append(elemento('p', 'casa-nota', 'Contesta y puede encender la PC aunque esté apagada.'));
      caja.append(botonCasa('Abrir Charlene', '', () => irASeccion('mini')));
      if (!pcCaida() && !pedida) caja.append(botonCasa('Instalar la llave de nuevo', 'discreta', pedirLlaveMini));
    } else if (pcCaida()) {
      caja.append(elemento('p', 'casa-nota', 'Este teléfono no tiene su llave, y solo se instala con la PC encendida.'));
    } else {
      caja.append(elemento('p', 'casa-nota', 'Contesta y puede encender la PC aunque esté apagada. Instala su llave ahora: con la PC apagada ya no se puede.'));
      if (!pedida) caja.append(botonCasa('Instalar la llave', '', pedirLlaveMini));
    }
  }

  // ---- su pantalla
  async function abrirMini() {
    pintarMini();
    if (!window.MiniDoof.instalada()) return;
    try {
      if (!window.MiniDoof.abierta()) await window.MiniDoof.abrir();
    } catch (e) {
      avisar(e.message);
      pintarMini();
      return;
    }
    if (!mini.menuAlDia) cargarMenuMini();
  }

  function ponerConexionMini(estado) {
    mini.conexion = estado;
    actualizarEstado();
  }

  async function cargarMenuMini() {
    ponerConexionMini('buscando');
    pintarAccionesMini();
    try {
      mini.menu = (await window.MiniDoof.pedir('menu')).botones || [];
      mini.menuAlDia = true;
      try { localStorage.setItem(CLAVE_MENU_MINI, JSON.stringify(mini.menu)); } catch (e) { /* solo adelanta los botones */ }
      ponerConexionMini('lista');
    } catch (e) {
      ponerConexionMini('caida');
    }
    pintarAccionesMini();
  }

  async function preguntarAMini(accion, titulo, texto) {
    const respuesta = { rol: 'bot', texto: '', esperando: true };
    mini.mensajes.push({ rol: 'usuario', texto: titulo }, respuesta);
    mini.mensajes = mini.mensajes.slice(-MAX_MENSAJES_MINI);
    mini.ocupado = true;
    mini.confirmando = null;
    pintarMini();
    try {
      const final = await window.MiniDoof.pedir(accion, {
        texto,
        alParcial: (m) => { respuesta.texto = m.texto || ''; pintarMensajesMini(); },
      });
      // La Pi le agrega a cada respuesta "💭 Charla libre: puedo inventar cosas...". Javier no la quiere en cada mensaje (6 nov 2026): el saludo ya lo dice una vez.
      respuesta.texto = (final.texto || '').replace(/^\s*💭.*$/gmu, '').trim();
      ponerConexionMini('lista');
    } catch (e) {
      respuesta.texto = MINI_NO_RESPONDE;
      respuesta.fallo = true;
      ponerConexionMini('caida');
    }
    respuesta.esperando = false;
    mini.ocupado = false;
    pintarMini();
  }

  function nodoMensajeMini(m) {
    if (m.rol === 'usuario') return elemento('div', 'msg usuario', m.texto);
    const d = elemento('div', m.esperando ? 'msg pensando' : 'msg bot');
    const o = ojo('chico');
    if (m.esperando) {
      o.classList.add('pensando');
      const t = elemento('div', 'pensando-texto');
      t.append(elemento('span', '', m.texto || 'Preguntándole a la Raspberry'));
      const puntos = elemento('span', 'puntos');
      puntos.innerHTML = '<i></i><i></i><i></i>';
      t.append(puntos);
      d.append(o, t);
      return d;
    }
    d.append(o, elemento('div', 'msg-cuerpo' + (m.fallo ? ' fallo' : ''), m.texto));
    return d;
  }

  function pintarMensajesMini() {
    const caja = $('#mini-mensajes');
    caja.textContent = '';
    if (window.MiniDoof.instalada()) caja.append(nodoMensajeMini({ rol: 'bot', texto: SALUDO_MINI }));
    else caja.append(nodoMensajeMini({ rol: 'bot', texto: pcCaida()
      ? 'Soy Charlene y vivo en la Raspberry, pero este teléfono todavía no tiene mi llave. Se instala con la PC encendida.'
      : 'Soy Charlene y vivo en la Raspberry: contesto aunque la PC esté apagada. Para eso, este teléfono necesita mi llave. Se instala una vez, con tu huella.' }));
    mini.mensajes.forEach((m) => caja.append(nodoMensajeMini(m)));
    caja.scrollTop = caja.scrollHeight;
  }

  function idsDelGrupoMini(nombre) {
    const conocidos = GRUPOS_MINI.flatMap(([, ids]) => ids);
    const [ultimo] = GRUPOS_MINI[GRUPOS_MINI.length - 1];
    return (mini.menu || []).filter(({ id }) => {
      const grupo = GRUPOS_MINI.find(([, ids]) => ids.includes(id));
      return grupo ? grupo[0] === nombre : nombre === ultimo && !conocidos.includes(id);
    });
  }

  function botonAccionMini(boton) {
    const destacado = boton.id === 'encender' && pcCaida();
    const b = elemento('button', 'mini-accion' + (destacado ? ' destacada' : ''), boton.titulo);
    b.type = 'button';
    b.disabled = mini.ocupado;
    b.addEventListener('click', () => {
      if (!MINI_CON_CONFIRMACION.has(boton.id)) { preguntarAMini(boton.id, boton.titulo); return; }
      mini.confirmando = boton;
      pintarAccionesMini();
    });
    return b;
  }

  function pintarAccionesMini() {
    const caja = $('#mini-acciones');
    const formulario = $('#mini-form');
    caja.textContent = '';
    formulario.hidden = !window.MiniDoof.instalada();
    $('#mini-enviar').disabled = mini.ocupado || !$('#mini-entrada').value.trim();
    if (!window.MiniDoof.instalada()) {
      if (!pcCaida()) caja.append(botonCasa('Instalar la llave', '', pedirLlaveMini));
      return;
    }
    if (mini.confirmando) {
      const { id, titulo } = mini.confirmando;
      const tarjeta = elemento('div', 'mini-confirmar');
      tarjeta.append(elemento('p', '', `¿${titulo}?`));
      if (id === 'encender') tarjeta.append(elemento('small', '', 'La Raspberry manda la señal, pero no confirma que haya arrancado.'));
      const si = botonCasa(`Sí, ${titulo.charAt(0).toLowerCase()}${titulo.slice(1)}`, 'principal', () => preguntarAMini(id, titulo));
      const no = botonCasa('No', '', () => { mini.confirmando = null; pintarAccionesMini(); });
      tarjeta.append(si, no);
      caja.append(tarjeta);
      return;
    }
    if (!mini.menu) {
      if (mini.conexion === 'caida') caja.append(botonCasa('Reintentar', '', cargarMenuMini));
      return;
    }
    const grupos = GRUPOS_MINI.map(([nombre]) => nombre).filter((nombre) => idsDelGrupoMini(nombre).length);
    if (!grupos.includes(mini.grupo)) mini.grupo = grupos[0];
    const pestanas = elemento('div', 'mini-pestanas');
    pestanas.setAttribute('role', 'tablist');
    for (const nombre of grupos) {
      const p = elemento('button', 'mini-pestana', nombre);
      p.type = 'button';
      p.setAttribute('role', 'tab');
      p.setAttribute('aria-selected', String(nombre === mini.grupo));
      p.addEventListener('click', () => { mini.grupo = nombre; pintarAccionesMini(); });
      pestanas.append(p);
    }
    const acciones = elemento('div', 'mini-grupo');
    acciones.setAttribute('role', 'tabpanel');
    const delGrupo = idsDelGrupoMini(mini.grupo);
    // Con la PC caída, encender es a lo que se viene: va primero.
    delGrupo.sort((a, b) => (pcCaida() ? (b.id === 'encender') - (a.id === 'encender') : 0));
    delGrupo.forEach((boton) => acciones.append(botonAccionMini(boton)));
    caja.append(pestanas, acciones);
  }

  function pintarMini() {
    pintarMensajesMini();
    pintarAccionesMini();
  }

  function enviarAMini(e) {
    e.preventDefault();
    const campo = $('#mini-entrada');
    const texto = campo.value.trim();
    if (!texto || mini.ocupado) return;
    campo.value = '';
    preguntarAMini('charla', texto, texto);
  }

  
  // ---------------------------------------------------------------- agente P
  const P = {
    convId: null,
    conversaciones: [],
    mensajes: [],
    objetivo: '',
    plataforma: 'tiktok',
    cargando: false,
  };

  function nodoMensajeP(m) {
    const esYo = (m.emisor === 'yo' || m.emisor === 'usuario' || m.rol === 'usuario' || m.rol === 'yo');
    const d = elemento('div', 'mensaje ' + (esYo ? 'yo' : 'doof'));
    const o = elemento('div', 'msg-origen');
    if (esYo) {
      o.textContent = 'Tú';
    } else {
      const img = elemento('img', 'p-msg-avatar');
      img.src = 'static/iconos/agente_p.png';
      img.alt = '';
      o.append(img, document.createTextNode('Agente P'));
    }

    const cuerpo = elemento('div', 'msg-cuerpo' + (m.fallo ? ' fallo' : ''));
    const lineas = (m.texto || '').split('\n');
    lineas.forEach((lin, idx) => {
      if (idx > 0) cuerpo.append(document.createElement('br'));
      cuerpo.append(document.createTextNode(lin));
    });

    if (m.esperando) {
      const sp = elemento('span', 'p-esperando', ' ⏳');
      cuerpo.append(sp);
    }

    d.append(o, cuerpo);

    if (m.adjunto) {
      const tarjeta = elemento('div', 'tarjeta-pdf-p');
      const cab = elemento('div', 'tarjeta-pdf-cab');
      cab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

      const meta = elemento('div', 'tarjeta-pdf-meta');
      meta.append(
        elemento('div', 'tarjeta-pdf-tit', m.adjunto.nombre || 'Expediente OSINT'),
        elemento('div', 'tarjeta-pdf-sub', 'Objetivo: ' + (m.adjunto.objetivo || 'Perfil'))
      );
      cab.append(meta);
      tarjeta.append(cab);

      const acciones = elemento('div', 'tarjeta-pdf-acciones');
      const enlacePdf = m.adjunto.pdf_url || m.adjunto.url;
      if (enlacePdf) {
        const aPdf = elemento('a', 'btn-pdf-descarga', '⬇️ Descargar PDF');
        aPdf.href = (S.base || '') + enlacePdf;
        aPdf.target = '_blank';
        aPdf.download = m.adjunto.nombre || 'expediente.pdf';
        acciones.append(aPdf);
      }
      if (m.adjunto.expediente_url) {
        const aWeb = elemento('a', 'btn-pdf-ver', '🌐 Ver en navegador');
        aWeb.href = (S.base || '') + m.adjunto.expediente_url;
        aWeb.target = '_blank';
        acciones.append(aWeb);
      }
      tarjeta.append(acciones);
      d.append(tarjeta);
    }

    return d;
  }

  function pintarMensajesP() {
    const caja = $('#p-mensajes');
    if (!caja) return;
    caja.textContent = '';

    if (!P.mensajes.length) {
      const saludo = {
        emisor: 'agente_p',
        texto: 'Agente P listo. ¿A quién investigo?',
      };
      caja.append(nodoMensajeP(saludo));
    } else {
      P.mensajes.forEach(m => caja.append(nodoMensajeP(m)));
    }

    const objElem = $('#p-objetivo-actual');
    const estElem = $('#p-estado-objetivo');
    if (objElem) objElem.textContent = P.objetivo ? ('@' + P.objetivo) : 'Agente P';
    if (estElem) estElem.textContent = P.objetivo ? `Objetivo activo (${P.plataforma})` : 'Sin objetivo fijado';

    caja.scrollTop = caja.scrollHeight;
  }

  function pintarHistorialP() {
    const lista = $('#p-lista-historial');
    if (!lista) return;
    lista.textContent = '';

    if (!P.conversaciones.length) {
      lista.append(elemento('p', 'vacio', 'No hay investigaciones previas.'));
      return;
    }

    P.conversaciones.forEach(c => {
      const item = elemento('div', 'item-historial-p' + (c.id === P.convId ? ' activo' : ''));
      const tit = elemento('strong', '', c.objetivo ? `@${c.objetivo}` : (c.titulo || 'Investigación'));
      const sub = elemento('small', '', `${(c.mensajes || []).length} mensajes · ${c.plataforma || 'tiktok'}`);
      item.append(tit, elemento('br'), sub);
      item.addEventListener('click', () => cargarDetalleP(c.id));
      lista.append(item);
    });
  }

  async function cargarConversacionesP() {
    try {
      const res = await api('/agente-p/conversaciones');
      P.conversaciones = res.conversaciones || [];
      pintarHistorialP();

      if (!P.convId && P.conversaciones.length > 0) {
        await cargarDetalleP(P.conversaciones[0].id);
      } else if (!P.convId) {
        await crearNuevaConversacionP();
      }
    } catch (e) {
      avisar('Error al cargar Agente P: ' + e.message);
    }
  }

  async function cargarDetalleP(convId) {
    try {
      const res = await api('/agente-p/conversaciones/' + convId);
      const conv = res.conversacion;
      P.convId = conv.id;
      P.mensajes = conv.mensajes || [];
      P.objetivo = conv.objetivo || '';
      P.plataforma = conv.plataforma || 'tiktok';
      pintarMensajesP();
      pintarHistorialP();
      cerrarHojas();
    } catch (e) {
      avisar('Error al abrir investigación: ' + e.message);
    }
  }

  async function crearNuevaConversacionP() {
    try {
      const res = await api('/agente-p/conversaciones/nueva', { method: 'POST' });
      const conv = res.conversacion;
      P.convId = conv.id;
      P.mensajes = [];
      P.objetivo = '';
      P.plataforma = 'tiktok';
      P.conversaciones.unshift(conv);
      pintarMensajesP();
      pintarHistorialP();
      cerrarHojas();
    } catch (e) {
      avisar('Error al crear investigación: ' + e.message);
    }
  }

  async function enviarMensajeP(e) {
    if (e) e.preventDefault();
    const campo = $('#p-entrada');
    const texto = campo.value.trim();
    if (!texto || P.cargando) return;

    campo.value = '';
    const btnEnviar = $('#p-enviar');
    if (btnEnviar) btnEnviar.disabled = true;

    // Agregar mensaje del usuario a la vista
    P.mensajes.push({ emisor: 'yo', texto });
    const msgEsperando = { emisor: 'agente_p', texto: 'Investigando perfil...', esperando: true };
    P.mensajes.push(msgEsperando);
    P.cargando = true;
    pintarMensajesP();

    try {
      const res = await api('/agente-p/mensaje', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conv_id: P.convId, texto }),
      }, 180000);

      // Quitar placeholder de espera
      const idxEsp = P.mensajes.indexOf(msgEsperando);
      if (idxEsp !== -1) P.mensajes.splice(idxEsp, 1);

      if (res.objetivo) P.objetivo = res.objetivo;
      if (res.plataforma) P.plataforma = res.plataforma;

      if (res.objetivo !== undefined) P.objetivo = res.objetivo;
      if (res.plataforma !== undefined) P.plataforma = res.plataforma;

      if (res.mensaje) {
        P.mensajes.push(res.mensaje);
      } else if (res.texto) {
        P.mensajes.push({ emisor: 'agente_p', texto: res.texto, adjunto: res.adjunto });
      }

      try {
        const histRes = await api('/agente-p/conversaciones');
        P.conversaciones = histRes.conversaciones || [];
        pintarHistorialP();
      } catch (eH) {}
    } catch (err) {
      const idxEsp = P.mensajes.indexOf(msgEsperando);
      if (idxEsp !== -1) P.mensajes.splice(idxEsp, 1);
      const esSinRed = err.sinRed || err.message?.includes('sin conexión');
      P.mensajes.push({
        emisor: 'agente_p',
        texto: esSinRed
          ? 'No hay conexión con la PC ahora mismo. Asegúrate de estar en la misma red WiFi y de que el bot esté corriendo.'
          : ('Error: ' + (err.message || 'operación fallida')),
        fallo: true,
      });
    } finally {
      P.cargando = false;
      if (btnEnviar) btnEnviar.disabled = !$('#p-entrada').value.trim();
      pintarMensajesP();
    }
  }

  async function abrirAgenteP() {
    pintarMensajesP();
    await cargarConversacionesP();
  }

  function iniciarAgenteP() {
    const form = $('#p-form');
    if (form) form.addEventListener('submit', enviarMensajeP);

    const entrada = $('#p-entrada');
    if (entrada) {
      entrada.addEventListener('input', () => {
        const btn = $('#p-enviar');
        if (btn) btn.disabled = P.cargando || !entrada.value.trim();
      });
    }

    const btnNuevaCab = $('#p-btn-nueva-cab');
    if (btnNuevaCab) btnNuevaCab.addEventListener('click', crearNuevaConversacionP);

    const btnNuevaHoja = $('#p-btn-nueva-hoja');
    if (btnNuevaHoja) btnNuevaHoja.addEventListener('click', crearNuevaConversacionP);

    const btnHistorialCab = $('#p-btn-historial-cab');
    if (btnHistorialCab) btnHistorialCab.addEventListener('click', () => abrirHoja('hoja-historial-p'));
  }


  function iniciarMini() {
    $('#mini-form').addEventListener('submit', enviarAMini);
    $('#mini-entrada').addEventListener('input', () => {
      $('#mini-enviar').disabled = mini.ocupado || !$('#mini-entrada').value.trim();
    });
    $('#mini-entrada').maxLength = MAX_TEXTO_MINI;
    $('#banda-mini').addEventListener('click', () => irASeccion('mini'));
  }

  // Sin esto, los WebSocket quedarían gastando batería con la app en segundo plano. La llave sigue guardada: al volver se reconecta sola.
  function alCambiarVisibilidadMini() {
    clearTimeout(mini.relojOcultar);
    if (document.hidden) {
      mini.relojOcultar = setTimeout(() => { window.MiniDoof.cerrar(); mini.conexion = ''; }, CERRAR_MINI_AL_OCULTAR_MS);
    } else if (S.vista === 'mini' && !window.MiniDoof.abierta()) {
      mini.menuAlDia = false;
      abrirMini();
    }
  }

  // ---------------------------------------------------------------- inicio
  function pintarFecha() {
    $('#fecha').textContent = capitalizar(fechaLarga());
    $('#saludo').textContent = `${saludo()}, ${NOMBRE}`;
  }

  // ---- lo último que se vio, guardado para pintar el inicio al instante (siempre rotulado con su antigüedad)
  function leerCache() {
    try { return JSON.parse(localStorage.getItem(CLAVE_CACHE)) || null; } catch (e) { return null; }
  }

  let relojCache = null;
  function guardarCache() {
    clearTimeout(relojCache);
    relojCache = setTimeout(() => {
      const ahora = Date.now();
      if (!S.token) return;
      const luz = resumenLuz(S.luz);
      try {
        const foto = {
          t: ahora,
          conversaciones: (S.conversaciones || []).filter((c) => c.cantidad > 0).slice(0, 20),
          continuar: adelantoContinuar(),
          pc: S.pc ? { encendida_hace: S.pc.encendida_hace, t: (S.pcLeida || new Date()).getTime() } : S.cache?.pc || null,
          luz: luz ? { titulo: luz.titulo, soc: luz.soc, t: (S.luzLeida || new Date()).getTime() } : S.cache?.luz || null,
          agentes: A.lista ? { trabajando: A.lista.trabajando, total: A.lista.sesiones.length, t: (A.leida || new Date()).getTime() } : S.cache?.agentes || null,
        };
        S.cache = foto;
        localStorage.setItem(CLAVE_CACHE, JSON.stringify(foto));
      } catch (e) { /* sin caché: el inicio sale como antes */ }
    }, 1000);
  }

  function adelantoContinuar() {
    if (!S.mensajes.length || S.soloLectura) return '';
    const ultimo = [...S.mensajes].reverse().find((m) => m.texto || m.adjunto);
    return ultimo ? (ultimo.texto || ('📎 ' + (ultimo.adjunto?.nombre || 'archivo'))).slice(0, 140) : '';
  }

  function haceTexto(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'hace un momento';
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
    return `hace ${Math.floor(s / 86400)} d`;
  }

  // Lo mismo que decide encabezadoLuz, en resumen para la tarjeta. Python ya resolvió el estado: aquí solo se nombra.
  function resumenLuz(d) {
    if (!d) return null;
    const soc = d.bateria?.soc_pct ?? null;
    if (d.estado === 'sin_respuesta' || d.estado === 'bms_desconectado' || d.falta_clave) return { clase: '', titulo: 'No sé si hay luz', soc, detalle: d.ultimo ? `Último dato ${d.ultimo.hace}` : 'La Raspberry no responde' };
    if (d.estado === 'sin_luz') return { clase: 'mal', titulo: 'Sin luz', soc, detalle: d.corte_actual ? `Lleva ${d.corte_actual.dura}` : 'Las baterías sostienen la casa' };
    const sentido = { cargando: 'cargando', descargando: 'descargando', reposo: 'en reposo' }[d.bateria?.sentido];
    return { clase: 'bien', titulo: 'Hay luz', soc, detalle: soc === null ? 'Batería sin dato' : `Batería ${soc} %${sentido ? ' · ' + sentido : ''}` };
  }

  function ponerMosaico(id, { clase = '', valor, detalle = '', medidor = null }) {
    const m = $('#' + id);
    m.className = 'mosaico' + (clase ? ' ' + clase : '');
    m.querySelector('.mosaico-valor').textContent = valor;
    m.querySelector('.mosaico-detalle').textContent = detalle;
    const barra = m.querySelector('.mosaico-medidor');
    if (barra) {
      barra.hidden = medidor === null;
      if (medidor !== null) {
        barra.className = 'mosaico-medidor' + (medidor <= 15 ? ' bajo' : medidor <= 35 ? ' medio' : '');
        barra.firstElementChild.style.width = Math.min(100, Math.max(0, medidor)) + '%';
      }
    }
  }

  function pintarEstadoCasa() {
    if (!$('#mosaico-pc')) return;
    const c = S.cache || {};
    const ahora = Date.now();
    const conectando = S.conectado !== true && S.conectado !== false;

    // PC
    const pcFresca = S.pc && S.pcLeida && ahora - S.pcLeida < PC_FRESCA_MS && S.conectado === true;
    if (S.conectado === false) ponerMosaico('mosaico-pc', { clase: 'mal', valor: 'Sin conexión', detalle: c.pc ? `Última lectura ${haceTexto(c.pc.t)}` : 'Reintentando…' });
    else if (pcFresca) ponerMosaico('mosaico-pc', { clase: 'bien', valor: 'Encendida', detalle: `CPU ${S.pc.cpu} % · RAM ${S.pc.ram} %` });
    else if (S.pcFalla && S.conectado === true) ponerMosaico('mosaico-pc', { clase: 'mal', valor: 'No responde', detalle: 'Toca para ver' });
    else if (conectando && c.pc) ponerMosaico('mosaico-pc', { clase: 'espera viejo', valor: 'Conectando…', detalle: `Última lectura ${haceTexto(c.pc.t)}` });
    else ponerMosaico('mosaico-pc', { clase: 'espera', valor: 'Conectando…', detalle: '' });

    // Luz: una lectura vieja nunca se presenta como "hay luz" (la Raspberry se reinicia con cada corte).
    const luzViva = S.luz && S.luzLeida && ahora - S.luzLeida < LUZ_FRESCA_MS ? resumenLuz(S.luz) : null;
    if (luzViva) ponerMosaico('mosaico-luz', { clase: luzViva.clase, valor: luzViva.titulo, detalle: luzViva.detalle, medidor: luzViva.clase === 'bien' || luzViva.clase === 'mal' ? luzViva.soc : null });
    else if (S.luzFalla) ponerMosaico('mosaico-luz', { valor: 'No sé si hay luz', detalle: 'No llegó la lectura' });
    else {
      const vieja = S.luz && S.luzLeida ? { titulo: resumenLuz(S.luz).titulo, soc: resumenLuz(S.luz).soc, t: S.luzLeida.getTime() } : c.luz;
      if (vieja) ponerMosaico('mosaico-luz', { clase: 'viejo', valor: 'Última lectura', detalle: `${vieja.soc === null || vieja.soc === undefined ? vieja.titulo : vieja.soc + ' %'} · ${haceTexto(vieja.t)}` });
      else ponerMosaico('mosaico-luz', { clase: S.conectado === true ? 'espera' : '', valor: S.conectado === true ? 'Mirando…' : 'Sin dato', detalle: '' });
    }

    // Agentes
    const fila = $('#mosaico-agentes');
    const texto = fila.querySelector('small');
    const lista = A.lista || null;
    let clase = '';
    if (lista) {
      const n = lista.trabajando;
      clase = n ? 'trabajando' : lista.sesiones.length ? 'bien' : '';
      texto.textContent = !lista.sesiones.length ? 'Ningún agente abierto' : n ? `${n} trabajando · ${lista.sesiones.length - n} libres` : 'Todos libres';
    } else if (A.falla) texto.textContent = 'No llego a los agentes';
    else if (c.agentes) { clase = ''; texto.textContent = `${c.agentes.trabajando ? c.agentes.trabajando + ' trabajando' : 'Todos libres'} · ${haceTexto(c.agentes.t)}`; }
    else texto.textContent = S.conectado === true ? 'Preguntándole a la PC…' : 'Sin dato';
    fila.className = 'fila-agentes' + (clase ? ' ' + clase : '');
  }

  function pintarMenuConexion() {
    const el = $('#menu-conexion');
    if (!el) return;
    // El tiempo que tardó en conectar queda a la vista a propósito: es lo que hay que comparar al medir, no adivinar.
    const tiempo = T.enlinea > T.inicio && T.inicio ? ` · conectó en ${((T.enlinea - T.inicio) / 1000).toFixed(1).replace('.', ',')} s` : '';
    el.textContent = S.conectado === true ? `PC en línea${tiempo}` : S.conectado === false ? 'PC sin conexión' : 'Conectando con la PC…';
  }

  // Las tarjetas del inicio se renuevan solas mientras se mira. Luz no se pide cada vez: consulta a la Raspberry y puede tardar hasta 30 s.
  let turnoInicio = 0;
  async function cargarEstadoInicio() {
    const turno = ++turnoInicio;
    if (S.vista !== 'inicio' || document.hidden || S.conectado !== true) return;
    const tareas = [cargarPc(), cargarAgentes()];
    if (!S.luzLeida || Date.now() - S.luzLeida > LUZ_FRESCA_MS) tareas.push(cargarLuz());
    await Promise.allSettled(tareas);
    if (turno !== turnoInicio || S.vista !== 'inicio') return;
    await pausa(REFRESCO_INICIO_MS);
    if (turno === turnoInicio) cargarEstadoInicio();
  }

  function pintarInicio() {
    pintarFecha();
    pintarEstadoCasa();

    // "Sigue donde ibas": la sesión activa, si tiene algo; mientras la PC no contesta, lo último que se vio.
    const continuar = $('#continuar');
    const adelanto = adelantoContinuar() || (!S.cargado && S.cache?.continuar) || '';
    continuar.hidden = !adelanto;
    $('#continuar-adelanto').textContent = adelanto;

    const recientes = S.conversaciones.filter(c => c.cantidad > 0).slice(0, 5);
    const caja = $('#recientes');
    caja.textContent = '';
    if (!recientes.length) {
      const vacio = document.createElement('div');
      vacio.className = 'vacio';
      vacio.textContent = 'Todavía no hay conversaciones. Pregúntale algo y aparece aquí.';
      caja.appendChild(vacio);
      return;
    }
    for (const c of recientes) caja.appendChild(filaConversacion(c, false));
  }

  function filaConversacion(c, enHistorial) {
    const boton = document.createElement('button');
    boton.className = 'fila' + (enHistorial && c.id === S.sesion && !S.soloLectura ? ' actual' : '');
    const icono = document.createElement('span');
    icono.className = 'fila-icono';
    icono.innerHTML = ICONOS.chat;
    const texto = document.createElement('span');
    texto.className = 'fila-texto';
    const titulo = document.createElement('b');
    titulo.textContent = c.adelanto || '(sin mensajes)';
    const meta = document.createElement('small');
    meta.textContent = fechaCorta(c.inicio) + ' · ' + c.cantidad + (c.cantidad === 1 ? ' mensaje' : ' mensajes');
    texto.append(titulo, meta);
    const flecha = document.createElement('span');
    flecha.className = 'flecha';
    flecha.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 5l7 7-7 7"/></svg>';
    boton.append(icono, texto, flecha);
    boton.addEventListener('click', () => {
      cerrarHojas();
      if (c.id === S.sesion && !S.soloLectura) irAChat();
      else verConversacion(c.id);
    });
    return boton;
  }

  async function cargarConversaciones(pintar = true) {
    try {
      S.conversaciones = await api('/conversaciones');
    } catch (e) {
      if (e.status === 401) return;
      S.conversaciones = [];
    }
    if (pintar) {
      pintarInicio();
      if ($('#hoja-historial').classList.contains('abierta')) pintarHistorial();
    }
  }

  // ---------------------------------------------------------------- mensajes
  function normalizarMensaje(m) {
    return {
      rol: m.rol === 'usuario' ? 'usuario' : 'bot',
      texto: limpiarHtml(m.texto || ''),
      adjunto: m.adjunto || null,
      botones: Array.isArray(m.botones) ? m.botones : [],
      ts: m.ts ? (m.ts > 1e12 ? m.ts : m.ts * 1000) : Date.now(),
      pendiente: !!m.pendiente,
      error: !!m.error,
    };
  }

  async function cargarSesion() {
    try {
      const d = await api('/sesion');
      S.sesion = d.sesion_id;
      S.mensajes = (d.mensajes || []).map(normalizarMensaje).slice(-MAX_MENSAJES);
      S.cargado = true;
    } catch (e) {
      if (e.status === 401) throw e;
      S.cargado = true;   // HUD caído: la app igual abre, en modo sin conexión
    }
  }

  function recibir(datos) {
    const m = normalizarMensaje(datos);
    if (S.evitarRepetidos && S.mensajes.slice(-5).some((x) => x.rol === m.rol && normalizar(x.texto) === normalizar(m.texto))) return;
    if (S.soloLectura) {
      // Estás leyendo un archivo: lo que llega en vivo es de la conversación activa, no de esta.
      if (m.rol === 'bot') avisar('Hay algo nuevo en tu conversación activa', 'Ver', () => volverActiva(true));
      programarRefrescoConversaciones();
      return;
    }
    if (m.rol === 'usuario') {
      const idx = S.mensajes.findIndex(x => x.pendiente && (
        (m.adjunto && x.adjunto && x.adjunto.nombre === m.adjunto.nombre) ||
        (!m.adjunto && !!m.texto && normalizar(x.texto) === normalizar(m.texto))
      ));
      if (idx >= 0) {
        S.mensajes[idx] = { ...m, pendiente: false, ts: S.mensajes[idx].ts };
      } else {
        S.mensajes.push(m);
      }
    } else {
      S.esperando = false;
      S.herramienta = '';
      S.mensajes.push(m);
      if (S.vista !== 'chat' || document.hidden) {
        avisar('Doof: ' + (m.texto || 'te mandó un archivo').slice(0, 90), 'Ver', () => { irAChat(); });
      }
    }
    if (S.mensajes.length > MAX_MENSAJES) S.mensajes = S.mensajes.slice(-MAX_MENSAJES);
    pintarMensajes();
    programarRefrescoConversaciones();
  }

  let temporizadorConversaciones = null;
  function programarRefrescoConversaciones() {
    clearTimeout(temporizadorConversaciones);
    temporizadorConversaciones = setTimeout(() => cargarConversaciones(), 1600);
  }

  function nodoAdjunto(a) {
    const caja = document.createElement('div');
    caja.className = 'adjunto';
    const url = urlAdjunto(a.url);
    const tipo = a.tipo || 'otro';
    const iconoDe = () => {
      const fila = document.createElement('div');
      fila.className = 'adjunto-archivo';
      const ic = document.createElement('span');
      ic.className = 'caja-icono';
      ic.innerHTML = tipo === 'pdf' ? ICONOS.pdf : tipo === 'imagen' ? ICONOS.imagen : ICONOS.archivo;
      const datos = document.createElement('span');
      datos.className = 'datos';
      const nombre = document.createElement('b');
      nombre.textContent = a.nombre || 'archivo';
      const peso = document.createElement('small');
      peso.textContent = pesoLegible(a.peso);
      datos.append(nombre, peso);
      fila.append(ic, datos);
      return fila;
    };
    if (url) {
      const img = document.createElement('img');
      img.alt = a.nombre || 'adjunto';
      img.addEventListener('error', () => {
        caja.textContent = '';
        caja.appendChild(iconoDe());
      });
      ponerImagen(img, url);
      img.addEventListener('click', () => verImagen(url));
      caja.appendChild(img);
      const pie = document.createElement('div');
      pie.className = 'pie';
      pie.textContent = (a.nombre || 'archivo') + (a.peso ? ' · ' + pesoLegible(a.peso) : '');
      caja.appendChild(pie);
    } else {
      caja.appendChild(iconoDe());
    }
    return caja;
  }

  function nodoMensaje(m, conBotones) {
    if (m.rol === 'usuario') {
      const d = document.createElement('div');
      d.className = 'msg usuario' + (m.pendiente ? ' pendiente' : '') + (m.error ? ' error' : '');
      if (m.adjunto) d.appendChild(nodoAdjunto(m.adjunto));
      if (m.texto) {
        const t = document.createElement('div');
        t.textContent = m.texto;
        d.appendChild(t);
      }
      return d;
    }

    const d = document.createElement('div');
    d.className = 'msg bot';
    d.appendChild(ojo('chico'));
    const cuerpo = document.createElement('div');
    cuerpo.className = 'msg-cuerpo';
    if (m.adjunto) cuerpo.appendChild(nodoAdjunto(m.adjunto));
    if (m.texto) {
      const t = document.createElement('div');
      t.textContent = m.texto;
      cuerpo.appendChild(t);
    }
    if (conBotones && m.botones.length) {
      const fila = document.createElement('div');
      fila.className = 'botones-msg';
      for (const bt of m.botones) {
        const b = document.createElement('button');
        b.textContent = limpiarHtml(bt.texto);
        b.addEventListener('click', () => {
          const texto = TEXTO_DE_BOTON[bt.datos] || limpiarHtml(bt.texto).replace(/^[^\wáéíóúüñ¿¡]+/i, '').trim();
          enviarTexto(texto);
        });
        fila.appendChild(b);
      }
      cuerpo.appendChild(fila);
    }

    if (conBotones) {
      const acciones = document.createElement('div');
      acciones.className = 'acciones-msg';
      const copiar = document.createElement('button');
      copiar.setAttribute('aria-label', 'Copiar');
      copiar.title = 'Copiar este mensaje';
      copiar.innerHTML = ICONOS.copiar;
      copiar.addEventListener('click', async () => {
        const ok = await copiarTexto(textoDe(m));
        avisar(ok ? 'Copiado' : 'No pude copiar');
      });
      acciones.appendChild(copiar);
      cuerpo.appendChild(acciones);
    }

    d.appendChild(cuerpo);
    return d;
  }

  function textoDe(m) {
    if (m.adjunto && !m.texto) return '📎 ' + (m.adjunto.nombre || 'archivo');
    return m.texto || '';
  }

  function nodoPensando() {
    const d = document.createElement('div');
    d.className = 'msg pensando';
    const o = ojo('chico');
    o.classList.add('pensando');
    d.appendChild(o);
    const t = document.createElement('div');
    t.className = 'pensando-texto';
    t.innerHTML = '<span>Doof piensa</span><span class="puntos"><i></i><i></i><i></i></span><small id="pensando-seg"></small>';
    d.appendChild(t);
    return d;
  }

  let intervaloPensando = null;
  function actualizarPensando() {
    const seg = $('#pensando-seg');
    if (!seg) return;
    const s = Math.max(0, Math.round((Date.now() - S.desde) / 1000));
    let texto = s >= 3 ? s + ' s' : '';
    const tool = TOOL_ES[S.herramienta];
    if (tool) texto = (texto ? texto + ' · ' : '') + tool;
    else if (s >= 45) texto = (texto ? texto + ' · ' : '') + 'sigue en eso';
    seg.textContent = texto ? ' · ' + texto : '';
  }

  function pintarMensajes() {
    const caja = $('#mensajes');
    const abajo = caja.scrollHeight - caja.scrollTop - caja.clientHeight < 90;
    caja.textContent = '';

    if (!S.mensajes.length && !S.esperando) {
      const d = document.createElement('div');
      d.className = 'msg bot';
      d.appendChild(ojo('chico'));
      const c = document.createElement('div');
      c.className = 'msg-cuerpo';
      c.textContent = S.soloLectura
        ? 'Esta conversación quedó guardada. Puedes leerla, pero para seguir hablando abre una nueva.'
        : 'Aquí estoy. Pregunta lo que sea o mándame un archivo.';
      d.appendChild(c);
      caja.appendChild(d);
    }

    let ultimoBot = -1;
    S.mensajes.forEach((m, i) => { if (m.rol === 'bot') ultimoBot = i; });
    S.mensajes.forEach((m, i) => {
      caja.appendChild(nodoMensaje(m, i === ultimoBot && !S.soloLectura));
    });

    if (S.esperando && !S.soloLectura) {
      caja.appendChild(nodoPensando());
      actualizarPensando();
      clearInterval(intervaloPensando);
      intervaloPensando = setInterval(actualizarPensando, 1000);
    } else {
      clearInterval(intervaloPensando);
    }

    if (abajo) alFinal(false);
    actualizarBotonAbajo();
  }

  function alFinal(suave) {
    const caja = $('#mensajes');
    caja.scrollTo({ top: caja.scrollHeight, behavior: suave ? 'smooth' : 'auto' });
  }

  function actualizarBotonAbajo() {
    const caja = $('#mensajes');
    const lejos = caja.scrollHeight - caja.scrollTop - caja.clientHeight > 160;
    $('#btn-abajo').hidden = !lejos;
  }

  // ---------------------------------------------------------------- enviar
  async function enviarTexto(texto) {
    texto = (texto || '').trim();
    if (!texto && !S.adjunto) return;

    if (S.soloLectura) await nuevaConversacion(false);

    if (S.adjunto) {
      const archivo = S.adjunto;
      const caption = texto;
      limpiarEntrada();
      quitarAdjunto();          // si no, la barra queda pegada y el próximo envío manda el archivo otra vez
      await subirArchivo(archivo, caption);
      return;
    }

    limpiarEntrada();
    const optimista = normalizarMensaje({ rol: 'usuario', texto, pendiente: true });
    S.mensajes.push(optimista);
    S.esperando = true;
    S.desde = Date.now();
    S.herramienta = '';
    irAChat();
    pintarMensajes();
    alFinal(false);

    try {
      await api('/mensaje', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texto }),
      });
    } catch (e) {
      optimista.pendiente = false;
      optimista.error = true;
      S.esperando = false;
      pintarMensajes();
      avisar('No pude mandarlo: ' + e.message);
    }
  }

  async function subirArchivo(archivo, caption) {
    const local = {
      nombre: archivo.name,
      tipo: archivo.type.startsWith('image/') ? 'imagen' : /\.pdf$/i.test(archivo.name) ? 'pdf' : 'otro',
      peso: archivo.size,
      url: archivo.type.startsWith('image/') ? URL.createObjectURL(archivo) : null,
    };
    const optimista = normalizarMensaje({ rol: 'usuario', texto: caption, adjunto: local, pendiente: true });
    S.mensajes.push(optimista);
    S.esperando = true;
    S.desde = Date.now();
    S.herramienta = 'analizar_archivo';
    irAChat();
    pintarMensajes();
    alFinal(false);

    const datos = new FormData();
    datos.append('archivo', archivo, archivo.name);
    datos.append('caption', caption || '');

    try {
      await api('/archivo', { method: 'POST', body: datos }, 180000);
    } catch (e) {
      optimista.pendiente = false;
      optimista.error = true;
      S.esperando = false;
      pintarMensajes();
      avisar('No pude subir el archivo: ' + e.message);
    } finally {
      setTimeout(() => { if (local.url) URL.revokeObjectURL(local.url); }, 60000);
    }
  }

  function limpiarEntrada() {
    const entrada = $('#entrada');
    entrada.value = '';
    ajustarEntrada();
  }

  function ajustarEntrada() {
    const entrada = $('#entrada');
    entrada.style.height = 'auto';
    entrada.style.height = Math.min(entrada.scrollHeight, 132) + 'px';
    $('#btn-enviar').disabled = !entrada.value.trim() && !S.adjunto;
  }

  // ---------------------------------------------------------------- adjuntos
  function prepararAdjunto(archivo) {
    if (!archivo) return;
    if (archivo.size > MAX_BYTES) {
      avisar('Ese archivo pasa de 25 MB');
      return;
    }
    quitarAdjunto();
    S.adjunto = archivo;
    const mini = $('#pendiente-mini');
    mini.textContent = '';
    if (archivo.type.startsWith('image/')) {
      S.adjuntoUrl = URL.createObjectURL(archivo);
      const img = document.createElement('img');
      img.src = S.adjuntoUrl;
      img.alt = archivo.name;
      mini.appendChild(img);
    } else {
      mini.innerHTML = /\.pdf$/i.test(archivo.name) ? ICONOS.pdf : ICONOS.archivo;
    }
    $('#pendiente-nombre').textContent = archivo.name;
    $('#pendiente-peso').textContent = pesoLegible(archivo.size) + ' · escribe algo si quieres';
    $('#pendiente').hidden = false;
    ajustarEntrada();
    cerrarHojas();
    $('#entrada').focus();
  }

  function quitarAdjunto() {
    if (S.adjuntoUrl) URL.revokeObjectURL(S.adjuntoUrl);
    S.adjuntoUrl = null;
    S.adjunto = null;
    $('#pendiente').hidden = true;
    $('#pendiente-mini').textContent = '';
    ajustarEntrada();
  }

  function verImagen(url) {
    const velo = $('#velo');
    velo.textContent = '';
    velo.className = 'velo visor';
    const img = document.createElement('img');
    ponerImagen(img, url);
    img.alt = 'Vista previa';
    velo.appendChild(img);
    velo.hidden = false;
    velo.onclick = cerrarVisor;
    empujarCapa('visor');
  }

  // ---------------------------------------------------------------- historial
  function abrirHoja(id) {
    if (hojaAbierta()) cerrarHojasUI();       // una hoja sustituye a la otra: la entrada del historial es la misma
    else empujarCapa('hoja');
    const hoja = $('#' + id);
    hoja.classList.add('abierta');
    hoja.setAttribute('aria-hidden', 'false');
    document.body.classList.add('con-hoja');
    if (id === 'hoja-historial') {
      pintarHistorial();
      setTimeout(() => $('#buscar').focus(), 250);
    }
    if (id === 'hoja-menu') {
      const actual = S.vista === 'chat' ? 'inicio' : S.vista;
      $$('#hoja-menu .fila').forEach((f) => f.classList.toggle('actual', f.dataset.destino === actual));
    }
  }

  const hojaAbierta = () => !!$('.hoja.abierta');

  function cerrarHojasUI() {
    for (const hoja of $$('.hoja')) {
      hoja.classList.remove('abierta');
      hoja.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('con-hoja');
  }

  function cerrarHojas() {
    const abierta = hojaAbierta();
    cerrarHojasUI();
    if (abierta && H.capas[H.capas.length - 1] === 'hoja') quitarCapas(1);
  }

  function cerrarVisorUI() {
    const velo = $('#velo');
    velo.hidden = true;
    velo.textContent = '';
  }

  function cerrarVisor() {
    cerrarVisorUI();
    if (H.capas[H.capas.length - 1] === 'visor') quitarCapas(1);
  }

  function pintarHistorial() {
    const caja = $('#lista-historial');
    caja.textContent = '';
    const filtro = normalizar(S.filtroHistorial);
    const lista = S.conversaciones
      .filter(c => c.cantidad > 0)
      .filter(c => !filtro || normalizar(c.adelanto).includes(filtro));

    if (!lista.length) {
      const vacio = document.createElement('div');
      vacio.className = 'vacio';
      vacio.textContent = filtro ? 'No hay nada que diga eso.' : 'Todavía no hay conversaciones guardadas.';
      caja.appendChild(vacio);
      return;
    }

    const grupos = new Map();
    for (const c of lista) {
      const g = grupoFecha(c.inicio);
      if (!grupos.has(g)) grupos.set(g, []);
      grupos.get(g).push(c);
    }
    for (const [nombre, items] of grupos) {
      const etiqueta = document.createElement('div');
      etiqueta.className = 'grupo';
      etiqueta.textContent = nombre;
      caja.appendChild(etiqueta);
      for (const c of items) caja.appendChild(filaConversacion(c, true));
    }
  }

  async function verConversacion(id) {
    try {
      const d = await api('/conversaciones/' + encodeURIComponent(id));
      S.soloLectura = true;
      S.esperando = false;
      S.inicioVista = d.inicio;
      S.sesionVista = id;
      S.mensajes = (d.mensajes || []).map(normalizarMensaje).slice(-MAX_MENSAJES);
      cerrarHojas();
      irAChat();
      pintarMensajes();
      actualizarBarra();
    } catch (e) {
      avisar('No pude abrir esa conversación: ' + e.message);
    }
  }

  async function nuevaConversacion(irInicio = true) {
    try {
      const d = await api('/sesion/nueva', { method: 'POST' });
      S.sesion = d.sesion_id;
    } catch (e) {
      avisar('No pude abrir una conversación nueva: ' + e.message);
      return;
    }
    S.mensajes = [];
    S.soloLectura = false;
    S.esperando = false;
    S.inicioVista = null;
    S.sesionVista = null;
    cerrarHojas();
    if (irInicio) irAInicio();
    pintarMensajes();
    pintarInicio();
    actualizarBarra();
    if (!irInicio) irAChat();
    avisar('Conversación nueva');
  }

  // ---------------------------------------------------------------- eventos
  function manejarEvento(tipo, datos) {
    if (tipo === 'mensaje') {
      recibir(datos);
    } else if (tipo === 'aprobacion') {
      // La tarjeta del WhatsApp vive sobre el compositor, que en Luz y PC no se ve: sin esto vencería sin que Javier la vea.
      cargarAprobaciones().then(() => {
        if ((S.vista === 'luz' || S.vista === 'pc') && S.aprobaciones.some((a) => !esDeOtraSeccion(a))) {
          avisar('Doof espera tu huella', 'Ver', () => irAChat());
        }
      });
    } else if (tipo === 'pensamiento') {
      if (datos.tool) S.herramienta = datos.tool;
      actualizarPensando();
    } else if (tipo === 'estado') {
      const e = datos.estado;
      if (e === 'STANDBY' && S.esperando && Date.now() - S.desde > 2000) {
        // El router volvió a reposo sin mensaje (atajo que contesta y sale): no dejamos el
        // "piensa" pegado para siempre. Si el mensaje llega después, entra igual.
        setTimeout(() => {
          if (Date.now() - S.desde > 2500) { S.esperando = false; pintarMensajes(); }
        }, 1200);
      }
    }
  }

  // ---------------------------------------------------------------- login
  function mostrarLogin(mensaje = '') {
    S.vuelta += 1;            // sin esto, los bucles seguirían probando un token malo y acabarían bloqueados
    S.conectando = false;
    $('#login').hidden = false;
    $('#login-error').textContent = mensaje;
    setTimeout(() => $('#token').focus(), 100);
    actualizarEstadoLogin();
  }

  function actualizarEstadoLogin() {
    const pill = $('#login-estado');
    if (!pill) return;
    pill.className = 'pastilla-estado conectando';
    pill.querySelector('span').textContent = 'Esperando el token';
  }

  async function entrar() {
    const token = $('#token').value.trim();
    const boton = $('#entrar');
    if (!token) return;
    boton.disabled = true;
    $('#login-error').textContent = '';
    S.token = token;
    if (ES_REMOTO) ponerBase('');
    try {
      const resultado = await intentarConexion();
      if (resultado === 'token') {
        S.token = '';
        $('#login-error').textContent = 'Ese token no abre a Doof.';
        $('#token').select();
        return;
      }
      guardar('doof_token', token);
      $('#login').hidden = true;
      $('#token').value = '';
      conectar();
    } finally {
      boton.disabled = false;
    }
  }

  // ---------------------------------------------------------------- arranque
  function arrancar() {
    S.token = leerGuardado('doof_token');
    if (ES_REMOTO) S.base = leerGuardado('doof_base');
    S.sobreEnlace = sobreDelEnlace();
    // Lo último que se vio, rotulado como tal, para que el inicio no salga vacío mientras la PC contesta.
    S.cache = S.token ? leerCache() : null;
    if (S.cache?.conversaciones) S.conversaciones = S.cache.conversaciones;
    pintarInicio();
    T.cache = Math.round(performance.now());
    actualizarBarra();
    actualizarEstado();
    if (!S.token) {
      mostrarLogin();
      return;
    }
    conectar();
  }

  function cablear() {
    $('#btn-enviar').addEventListener('click', () => enviarTexto($('#entrada').value));
    $('#btn-atras').addEventListener('click', atras);
    $('#btn-historial').addEventListener('click', () => abrirHoja('hoja-menu'));
    $$('#hoja-menu .fila').forEach((f) => f.addEventListener('click', () => alElegirDelMenu(f.dataset.destino)));
    $('#btn-nueva-barra').addEventListener('click', () => nuevaConversacion());
    $('#ver-todo').addEventListener('click', () => abrirHoja('hoja-historial'));
    $('#continuar').addEventListener('click', () => irAChat());
    $('#btn-nueva').addEventListener('click', () => nuevaConversacion());
    $('#btn-nueva-lectura').addEventListener('click', () => nuevaConversacion());
    $('#btn-adjuntar').addEventListener('click', () => abrirHoja('hoja-adjuntar'));
    $('#pendiente-quitar').addEventListener('click', quitarAdjunto);
    $('#entrar').addEventListener('click', entrar);
    $('#token').addEventListener('keydown', (e) => { if (e.key === 'Enter') entrar(); });

    $('#entrada').addEventListener('input', ajustarEntrada);
    $('#entrada').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        enviarTexto($('#entrada').value);
      }
    });

    $('#buscar').addEventListener('input', (e) => { S.filtroHistorial = e.target.value; pintarHistorial(); });

    $$('.hoja .cerrar').forEach(b => b.addEventListener('click', cerrarHojas));
    $$('.hoja').forEach(hoja => hoja.addEventListener('click', (e) => { if (e.target === hoja) cerrarHojas(); }));

    $$('.opciones-adjunto button').forEach(b => b.addEventListener('click', () => {
      const tipo = b.dataset.tipo;
      if (tipo === 'camara') $('#archivo-camara').click();
      else if (tipo === 'galeria') $('#archivo-galeria').click();
      else $('#archivo-general').click();
    }));
    for (const id of ['#archivo-camara', '#archivo-galeria', '#archivo-general']) {
      $(id).addEventListener('change', (e) => {
        const archivo = e.target.files?.[0];
        e.target.value = '';
        prepararAdjunto(archivo);
      });
    }

    $('#chips').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-texto]');
      if (b) enviarTexto(b.dataset.texto);
    });

    $('#mensajes').addEventListener('scroll', actualizarBotonAbajo);
    $('#btn-abajo').addEventListener('click', () => alFinal(true));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') atras();
    });

    window.addEventListener('popstate', alGestoAtras);

    $('#estado-casa').addEventListener('click', (e) => {
      const destino = e.target.closest('[data-destino]')?.dataset.destino;
      if (destino) irASeccion(destino);
    });
    $('#menu-salir').addEventListener('click', cerrarSesion);

    document.addEventListener('paste', (e) => {
      const item = Array.from(e.clipboardData?.items || []).find(i => i.kind === 'file');
      if (item) {
        const archivo = item.getAsFile();
        if (archivo) { e.preventDefault(); prepararAdjunto(archivo); }
      }
    });

    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      const archivo = e.dataTransfer?.files?.[0];
      if (archivo) { e.preventDefault(); prepararAdjunto(archivo); }
    });

    iniciarMini();
    iniciarAgenteP();
    document.addEventListener('visibilitychange', () => {
      alCambiarVisibilidadMini();
      if (document.hidden) return;
      revisarAlVolver();
      refrescarSeccion();
      cargarEstadoInicio();
    });
    window.addEventListener('online', revisarAlVolver);     // volvió la señal del teléfono: no hay por qué esperar al siguiente reintento

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      S.instalable = e;
      mostrarBotonInstalar();
    });
  }

  function mostrarBotonInstalar() {
    const boton = $('#menu-instalar');
    if (!boton || window.matchMedia('(display-mode: standalone)').matches) return;
    boton.hidden = false;
    boton.onclick = async () => {
      if (!S.instalable) return;
      S.instalable.prompt();
      await S.instalable.userChoice;
      S.instalable = null;
      boton.hidden = true;
    };
  }

  // Dos toques: cerrar sesión borra el token y la dirección guardados, y no se debe poder hacer sin querer.
  function cerrarSesion() {
    const boton = $('#menu-salir');
    if (!boton.classList.contains('confirmar')) {
      boton.classList.add('confirmar');
      boton.textContent = 'Toca otra vez para cerrar sesión';
      setTimeout(() => { boton.classList.remove('confirmar'); boton.textContent = 'Cerrar sesión'; }, 4000);
      return;
    }
    S.vuelta += 1;
    for (const clave of ['doof_token', 'doof_base', CLAVE_CACHE]) guardar(clave, '');
    location.reload();
  }

  function registrarSW() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  // ---------------------------------------------------------------- copiar / avisar
  async function copiarTexto(texto) {
    try {
      await navigator.clipboard.writeText(texto);
      return true;
    } catch (e) {
      const t = document.createElement('textarea');
      t.value = texto;
      t.style.position = 'fixed';
      t.style.opacity = '0';
      document.body.appendChild(t);
      t.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { /* nada */ }
      t.remove();
      return ok;
    }
  }

  let temporizadorAviso = null;
  function avisar(texto, accionTexto, accion) {
    const caja = $('#aviso');
    caja.textContent = '';
    caja.appendChild(document.createTextNode(texto));
    if (accionTexto && accion) {
      const b = document.createElement('button');
      b.textContent = accionTexto;
      b.addEventListener('click', () => { caja.hidden = true; accion(); });
      caja.appendChild(b);
    }
    caja.hidden = false;
    clearTimeout(temporizadorAviso);
    temporizadorAviso = setTimeout(() => { caja.hidden = true; }, 4500);
  }

  // ---------------------------------------------------------------- init
  function iniciar() {
    cablear();
    pintarFecha();
    document.body.dataset.vista = 'inicio';
    $('#menu-version').textContent = `DoofApp ${VERSION}`;
    registrarSW();
    iniciarHistorial();
    arrancar();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
