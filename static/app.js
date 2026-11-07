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
    luzLeida: null,
    pc: null,
    pcFalla: null,
    apagadoHasta: 0,          // en el reloj del teléfono: el servidor manda cuánto falta, no una hora
    turnoSeccion: 0,          // cambiarlo deja sin efecto el refresco de una sección que ya no se ve
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
  const REFRESCO_LUZ_MS = 15000;
  const REFRESCO_PC_MS = 10000;
  const TIEMPO_LUZ_MS = 35000;
  const APAGANDO_COMO_MAXIMO_MS = 3 * 60 * 1000;   // si sigue viva pasado esto, Windows no llegó a apagarse
  const TIPO_APAGAR = 'apagar_pc';
  const TIPO_PAGO = 'pago_movil';
  const TITULOS_DE_VISTA = { luz: 'Luz de la casa', pc: 'La PC', agentes: 'Agentes' };

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
      const avisos = { [TIPO_APAGAR]: 'Cancelado: la PC sigue prendida.', [TIPO_PAGO]: 'Cancelado: no se movió nada.' };
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

  // La de apagar vive en la sección PC: en el chat, un botón de apagar junto a lo que se escribe sería un mal toque esperando a pasar.
  function pintarAprobaciones() {
    const caja = $('#aprobaciones');
    const cajaPc = $('#pc-aprobacion');
    const escrito = $('#codigo-huella')?.value;
    const delChat = S.aprobaciones.filter((a) => a.tipo !== TIPO_APAGAR);
    caja.textContent = '';
    cajaPc.textContent = '';
    delChat.forEach((a) => caja.appendChild(a.tipo === TIPO_PAGO ? tarjetaPago(a) : tarjetaAprobacion(a)));
    S.aprobaciones.filter((a) => a.tipo === TIPO_APAGAR).slice(0, 1).forEach((a) => cajaPc.appendChild(tarjetaApagado(a)));
    if (escrito && $('#codigo-huella')) $('#codigo-huella').value = escrito;
    caja.hidden = !delChat.length;
    document.body.classList.toggle('con-aprobacion', delChat.length > 0);     // el aviso flotante no debe tapar sus botones; la de apagar no está abajo
    if (S.vista === 'pc') pintarAccionesPc();
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
    $('#vista-luz').classList.toggle('activa', S.vista === 'luz');
    $('#vista-pc').classList.toggle('activa', S.vista === 'pc');
    $('#vista-agentes').classList.toggle('activa', S.vista === 'agentes');
    $('#btn-atras').hidden = S.vista === 'inicio';
    $('#btn-nueva-barra').hidden = S.vista !== 'chat';
    $('#btn-historial').hidden = false;
    $('#barra-titulo').textContent = S.vista === 'chat' && S.soloLectura && S.inicioVista
      ? capitalizar(fechaLarga(new Date(S.inicioVista)))
      : TITULOS_DE_VISTA[S.vista] || 'Doof';
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

  // Entre vistas se reemplaza la entrada del historial: "atrás" siempre vuelve al inicio, no recorre lo que se fue abriendo.
  function entrarAVista(vista) {
    const desdeInicio = S.vista === 'inicio';
    S.vista = vista;
    actualizarBarra();
    if (desdeInicio) history.pushState({ vista }, '');
    else history.replaceState({ vista }, '');
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
    else if (vista === 'agentes') pintarAgentes();
    else pintarPc();
    $('#vista-' + vista).scrollTop = 0;
    refrescarSeccion();
  }

  function alElegirDelMenu(destino) {
    cerrarHojas();
    if (destino === 'conversaciones') abrirHoja('hoja-historial');
    else if (destino === 'inicio') {
      if (S.soloLectura) volverActiva(false);
      else if (history.state?.vista) history.back();
      else irAInicio();
    } else irASeccion(destino);
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

  // ---------------------------------------------------------------- agentes
  // Solo lectura: Doof lista las sesiones de agentes de terminal de la PC y lo que dejaron; aquí no se les da órdenes. El aviso de "terminó"
  // llega como un mensaje más de Doof por el chat, así que no hay nada que escuchar aparte.
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
    caja.appendChild(encabezadoCasa(trabajando ? 'mal' : 'bien', d.nombre, `${d.proyecto} · ${trabajando ? 'trabajando desde' : 'libre desde'} ${d.hace}`));
    if (d.titulo || d.pedido) {
      caja.appendChild(elemento('p', 'casa-subtitulo', 'Lo último que le pidieron'));
      caja.appendChild(elemento('p', 'agente-pedido', d.pedido || d.titulo));
    }
    caja.appendChild(elemento('p', 'casa-subtitulo', trabajando ? 'Lo que lleva dicho' : 'Lo que dejó'));
    caja.appendChild(elemento('div', 'agente-resultado', d.resultado || (trabajando ? 'Sigue en eso: todavía no ha escrito nada que mostrar.' : 'No dejó ningún texto.')));
    if (d.mensajes && d.mensajes.length > 1) {
      const mas = elemento('details', 'agente-mas');
      mas.append(elemento('summary', '', `Mensajes anteriores del turno (${d.mensajes.length - 1})`));
      for (const m of d.mensajes.slice(0, -1)) mas.append(elemento('div', 'agente-resultado', m));
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
      caja.appendChild(encabezadoCasa(n ? 'mal' : 'bien', n ? `${n} trabajando` : 'Todos libres', n ? 'Te aviso por el chat cuando termine cada uno.' : 'Ninguno está ocupado ahora.'));
      const lista = elemento('div', 'agentes-lista');
      for (const a of A.lista.sesiones) lista.appendChild(filaAgente(a));
      caja.appendChild(lista);
    }
    if (A.leida && !A.abierto) caja.appendChild(elemento('p', 'casa-nota', `Leído a las ${hora(A.leida)}. Solo se miran: desde aquí no se les manda nada.`));
  }

  // ---------------------------------------------------------------- luz y PC
  // Todo llega resuelto de Doof: aquí no se decide si hay luz ni se calcula nada, solo se pinta.
  async function refrescarSeccion() {
    const turno = ++S.turnoSeccion;
    const vista = S.vista;
    if (vista !== 'luz' && vista !== 'pc' && vista !== 'agentes') return;
    if (!document.hidden) await (vista === 'luz' ? cargarLuz() : vista === 'agentes' ? cargarAgentes() : cargarPc());
    if (turno !== S.turnoSeccion || S.vista !== vista) return;
    await pausa(vista === 'luz' ? REFRESCO_LUZ_MS : vista === 'agentes' ? REFRESCO_AGENTES_MS : REFRESCO_PC_MS);
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
    if (e.sinRed) return 'No llego a la PC. Puede estar apagada o sin internet: desde aquí no se distingue.';
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
    const encender = botonCasa('Encender la PC');
    encender.disabled = true;
    caja.append(encender);
    caja.append(elemento('p', 'casa-nota', 'Encender desde aquí todavía no se puede: falta la prueba de Wake-on-LAN y configurar la Raspberry.'));
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
    if (id === 'hoja-menu') {
      const actual = S.vista === 'chat' ? 'inicio' : S.vista;
      $$('#hoja-menu .fila').forEach((f) => f.classList.toggle('actual', f.dataset.destino === actual));
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
      // La tarjeta del WhatsApp vive sobre el compositor, que en Luz y PC no se ve: sin esto vencería sin que Javier la vea.
      cargarAprobaciones().then(() => {
        if ((S.vista === 'luz' || S.vista === 'pc') && S.aprobaciones.some((a) => a.tipo !== TIPO_APAGAR)) {
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
      if (history.state?.vista) history.back();
      else irAInicio();
    });
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
      if (e.key === 'Escape') {
        if (!$('#velo').hidden) { $('#velo').hidden = true; $('#velo').textContent = ''; return; }
        if ($('.hoja.abierta')) { cerrarHojas(); return; }
        if (S.vista !== 'inicio') volver();
      }
    });

    window.addEventListener('popstate', () => {
      if (S.vista !== 'inicio') volver();
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
      if (document.hidden) return;
      revisarAlVolver();
      refrescarSeccion();
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
