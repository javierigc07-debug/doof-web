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
  };

  const NOMBRE = 'Javier';
  const MAX_MENSAJES = 200;
  const MAX_BYTES = 25 * 1024 * 1024;
  const ES_REMOTO = location.hostname.endsWith('.github.io');
  const URL_DIRECCION = 'https://api.github.com/repos/javierigc07-debug/doof-web/contents/tunel.json?ref=tunel';
  const PATRON_TUNEL = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;
  const ESPERA_NOVEDADES_S = 25;
  // GitHub da 60 lecturas por hora sin autenticar: con la PC apagada, un reintento fijo cada 10 s las agotaría en diez
  // minutos y la app seguiría sin poder leer la dirección cuando la PC volviera.
  const REINTENTOS_S = [10, 10, 20, 30, 60, 60, 120, 300];

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

  async function api(ruta, opciones = {}, tiempoMs = 20000) {
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
        mostrarLogin('Ese token ya no sirve.');
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
    if (!r.ok) throw new Error('GitHub respondió ' + r.status);
    return abrirSobre(await r.json());
  }

  function sobreDelEnlace() {
    const m = location.hash.match(/^#s=(.+)$/);
    if (!m) return null;
    history.replaceState(null, '', location.pathname);
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

  async function probarBase() {
    if (ES_REMOTO && !S.base) return 'sin-red';
    try {
      const d = await api('/salud', {}, 10000);
      S.salud = !!d.hud;
      return d.auth ? 'ok' : 'token';
    } catch (e) {
      return 'sin-red';
    }
  }

  async function intentarConexion() {
    if (S.sobreEnlace) {
      const sobre = S.sobreEnlace;
      S.sobreEnlace = null;
      // Un link viejo o mal pegado no debe sacar a nadie: si no abre, sigue el camino normal.
      try { ponerBase((await abrirSobre(sobre)).url); } catch (e) { /* nada */ }
    }
    const primera = await probarBase();
    if (primera !== 'sin-red' || !ES_REMOTO) return primera;
    try {
      const { url } = await leerDireccionPublicada();
      if (url === S.base) return 'sin-red';
      ponerBase(url);
    } catch (e) {
      return e.name === 'OperationError' ? 'token' : 'sin-red';
    }
    return probarBase();
  }

  async function ponerseAlDia() {
    const d = await api('/novedades?desde=-1', {}, 15000);
    // Tras una caída breve, /novedades entrega lo que se perdió. Solo se recarga todo si el puente reinició.
    if (d.ciclo !== S.ciclo || !S.cargado) {
      S.ciclo = d.ciclo;
      S.cursor = d.ultimo;
      await cargarSesion();
      S.evitarRepetidos = true;     // lo que llegó entre el cursor y la sesión vendría dos veces
      pintarMensajes();
      pintarInicio();
    }
    await cargarConversaciones(false);
    await cargarAprobaciones();
    pintarInicio();
    actualizarBarra();
    if (!S.enlaceInicialVisto) {
      S.enlaceInicialVisto = true;
      // Deep link desde una notificación: ?sesion=<id> abre ese archivo.
      const sesion = new URLSearchParams(location.search).get('sesion');
      if (sesion) {
        history.replaceState({}, '', location.pathname);
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
    if (e.name === 'NotAllowedError') return 'Cancelaste la huella: no envié nada.';
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
      await postJson(`/aprobaciones/${aprobacion.id}/confirmar`, {
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
      S.esperando = true;
      S.desde = Date.now();
      S.herramienta = 'mandar_whatsapp';
      irAChat();
      pintarMensajes();
    } catch (e) {
      avisar(mensajeDeHuella(e));
    }
    await cargarAprobaciones();
  }

  async function cancelarAprobacion(aprobacion) {
    try {
      await postJson(`/aprobaciones/${aprobacion.id}/cancelar`);
      avisar('Cancelado: no envié nada.');
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
    const acciones = document.createElement('div');
    acciones.className = 'acciones';
    if (!huellaDisponible()) {
      const nota = document.createElement('p');
      nota.className = 'nota';
      nota.textContent = 'La huella solo funciona en la app instalada del teléfono.';
      caja.append(nota);
    } else if (S.huellaRegistrada) {
      acciones.append(botonDe('Enviar con huella', (b) => confirmarConHuella(aprobacion, b), true));
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
      nota.textContent = 'Para enviar desde la app, primero activa la huella en este teléfono.';
      caja.append(nota);
      acciones.append(botonDe('Activar huella', pedirCodigo, true));
    }
    acciones.append(botonDe('Cancelar', () => cancelarAprobacion(aprobacion)));
    caja.append(acciones);
    return caja;
  }

  function pintarAprobaciones() {
    const caja = $('#aprobaciones');
    const escrito = $('#codigo-huella')?.value;
    caja.textContent = '';
    S.aprobaciones.forEach((a) => caja.appendChild(tarjetaAprobacion(a)));
    if (escrito && $('#codigo-huella')) $('#codigo-huella').value = escrito;
    caja.hidden = !S.aprobaciones.length;
    document.body.classList.toggle('con-aprobacion', S.aprobaciones.length > 0);     // el aviso flotante no debe tapar sus botones
  }

  async function conectar() {
    if (S.conectando) return;
    S.conectando = true;
    const vuelta = ++S.vuelta;
    let intento = 0;
    while (vuelta === S.vuelta) {
      await esperarVisible();
      const resultado = await intentarConexion();
      if (vuelta !== S.vuelta) return;
      if (resultado === 'token') {
        mostrarLogin('Ese token no abre a Doof.');
        return;
      }
      if (resultado === 'ok') {
        try {
          await ponerseAlDia();
          if (vuelta !== S.vuelta) return;
          S.conectando = false;
          S.conectado = true;
          actualizarEstado();
          bucleNovedades(vuelta);
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
    despertar();
    if (!$('#login').hidden || S.conectando) return;
    // El sistema pudo congelar la consulta abierta mientras la app estaba en segundo plano: esto no la espera.
    if ((await probarBase()) !== 'ok') conectar();
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

    $('#barra-sub').textContent = S.soloLectura ? 'solo lectura' : texto;

    const mostrar = (S.conectado === false || S.salud === false) && !S.soloLectura;
    $('#banda').hidden = !mostrar;
    if (mostrar) $('#banda-texto').textContent = 'PC sin conexión · reintentando…';
  }

  function actualizarBarra() {
    document.body.dataset.vista = S.vista;
    $('#vista-inicio').classList.toggle('activa', S.vista === 'inicio');
    $('#vista-chat').classList.toggle('activa', S.vista === 'chat');
    $('#btn-atras').hidden = S.vista === 'inicio';
    $('#btn-nueva-barra').hidden = S.vista === 'inicio';
    $('#btn-historial').hidden = false;
    $('#barra-titulo').textContent = S.vista === 'chat' && S.soloLectura && S.inicioVista
      ? capitalizar(fechaLarga(new Date(S.inicioVista)))
      : 'Doof';
    $('#aviso-lectura').hidden = !(S.vista === 'chat' && S.soloLectura);
    actualizarEstado();
  }

  function irAInicio() {
    if (S.vista === 'inicio') return;
    S.vista = 'inicio';
    actualizarBarra();
    cerrarHojas();
    pintarInicio();
  }

  function irAChat() {
    if (S.vista !== 'chat') {
      S.vista = 'chat';
      actualizarBarra();
      history.pushState({ vista: 'chat' }, '');
    }
    pintarMensajes();
    setTimeout(() => alFinal(true), 30);
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
      history.replaceState({ vista: 'chat' }, '');
      setTimeout(() => alFinal(true), 30);
    }
  }

  function volver() {
    if (S.soloLectura) volverActiva(false);
    else irAInicio();
  }

  // ---------------------------------------------------------------- inicio
  function pintarFecha() {
    $('#fecha').textContent = capitalizar(fechaLarga());
    $('#saludo').textContent = `${saludo()}, ${NOMBRE}`;
  }

  function pintarInicio() {
    pintarFecha();

    // "Sigue donde ibas": la sesión activa, si tiene algo.
    const continuar = $('#continuar');
    if (S.mensajes.length && !S.soloLectura) {
      const ultimo = [...S.mensajes].reverse().find(m => m.texto || m.adjunto);
      continuar.hidden = false;
      $('#continuar-adelanto').textContent = ultimo
        ? (ultimo.texto || ('📎 ' + (ultimo.adjunto?.nombre || 'archivo')))
        : '';
    } else {
      continuar.hidden = true;
    }

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
    const cerrar = () => { velo.hidden = true; velo.textContent = ''; };
    velo.addEventListener('click', cerrar, { once: true });
  }

  // ---------------------------------------------------------------- historial
  function abrirHoja(id) {
    cerrarHojas();
    const hoja = $('#' + id);
    hoja.classList.add('abierta');
    hoja.setAttribute('aria-hidden', 'false');
    document.body.classList.add('con-hoja');
    if (id === 'hoja-historial') {
      pintarHistorial();
      setTimeout(() => $('#buscar').focus(), 250);
    }
  }

  function cerrarHojas() {
    for (const hoja of $$('.hoja')) {
      hoja.classList.remove('abierta');
      hoja.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('con-hoja');
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
      cargarAprobaciones();
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
    pintarInicio();
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
    $('#btn-atras').addEventListener('click', () => {
      if (S.soloLectura) { volverActiva(false); return; }
      if (history.state?.vista === 'chat') history.back();
      else irAInicio();
    });
    $('#btn-historial').addEventListener('click', () => abrirHoja('hoja-historial'));
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
      if (e.key === 'Escape') {
        if (!$('#velo').hidden) { $('#velo').hidden = true; $('#velo').textContent = ''; return; }
        if ($('.hoja.abierta')) { cerrarHojas(); return; }
        if (S.vista === 'chat') volver();
      }
    });

    window.addEventListener('popstate', () => {
      if (S.vista === 'chat') volver();
    });

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

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) revisarAlVolver();
    });

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      S.instalable = e;
      mostrarBotonInstalar();
    });
  }

  function mostrarBotonInstalar() {
    if ($('#instalar') || window.matchMedia('(display-mode: standalone)').matches) return;
    const b = document.createElement('button');
    b.id = 'instalar';
    b.className = 'enlace';
    b.textContent = 'Instalar Doof en el teléfono';
    b.style.margin = '10px auto 0';
    b.addEventListener('click', async () => {
      if (!S.instalable) return;
      S.instalable.prompt();
      await S.instalable.userChoice;
      S.instalable = null;
      b.remove();
    });
    $('.pie-inicio').before(b);
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
    document.body.style.setProperty('--altura', window.innerHeight + 'px');
    registrarSW();
    arrancar();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
