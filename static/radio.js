/* DoofApp — sección Radio. Lo que suena lo resuelve Doof (comandos/radio_fm.py: "Sección Radio de DoofApp"); aquí solo se pinta,
   se sintoniza y se escucha. Vive aparte de app.js y le habla por window.DoofApp (api, avisar, base); app.js le pasa los eventos
   "radio" del long-polling con window.DoofRadio.evento().

   Decisiones de Javier (15 nov 2026), maqueta aprobada en https://claude.ai/artifact/JA5MEwkiRQmH84bP5twA7h:
   · El dial es un sintonizador como el del carro: aguja fija, se desliza, ‹ › salta de radio. Donde se para la aguja, Doof escucha
     esa radio ya mismo (si no la escuchó hace menos de un minuto).
   · Se actualiza solo: cada radio llega apenas Doof la reconoce. Mientras la sección está abierta, Doof escucha las favoritas aunque el
     vigía esté apagado; al salir, deja de escuchar (no gasta consultas a Shazam).
   · Escuchar suena dentro de la app y sigue en segundo plano (Media Session: controles en la pantalla de bloqueo). Las radios https
     se tocan directo; las http, o todas con «Ahorro de datos», pasan por la PC.
   · Las favoritas son las de siempre; solo cambian si Javier toca la estrella. */

(() => {
  'use strict';

  const PX_MHZ = 160;
  const F_MIN = 87.5;
  const REFRESCO_MS = 45000;           // renueva el "estoy mirando" del HUD (dura 90 s) y trae lo que se haya perdido
  const ESPERA_SINTONIA_MS = 700;      // la aguja tiene que quedarse quieta esto antes de pedir que Doof escuche esa radio
  // 17 nov 2026: RadioDoof se quedaba muda y había que salir y volver a ponerla. El log de la PC lo mostraba: la emisión se apagaba
  // «sin oyentes» y Javier volvía a entrar a mano un minuto después. Chrome en Android, cuando el túnel o la red cortan el stream,
  // suele quedarse esperando datos para siempre sin disparar 'error' ni 'ended'. Por eso se vigila que el audio avance de verdad, y se
  // reintenta sin tope mientras Javier quiera escuchar.
  const ESPERA_MAX_REINTENTO_MS = 10000;
  const SILENCIO_MAX_MS = 10000;        // sonando sin avanzar esto: el stream murió
  const CONECTANDO_MAX_MS = 20000;      // conectando sin arrancar esto: se intenta de nuevo
  const AVISO_CORTE_MS = 60000;
  const CLAVE_AHORRO = 'doof_radio_ahorro';

  const R = {
    datos: null,
    cargadoEn: 0,
    falla: '',
    sintonizada: null,
    pestana: 'fav',
    busqueda: '',
    nuevos: new Set(),
    consultando: new Set(),
    sonando: null,            // id de la radio que suena en el <audio>
    pausado: false,
    reintentos: 0,
    cargandoAudio: false,
    intento: 0,               // cada conexión nueva lo sube: una vieja que termina tarde no pisa el estado de la nueva
    conectandoDesde: 0,
    reconexion: 0,            // timer del próximo reintento
    cortadoDesde: 0,
    avisadoCorte: false,
    ultimoTiempo: -1,
    ultimoAvance: 0,
    spotify: new Map(),       // "artista|titulo" -> enlace exacto
    ahorro: leerAhorro(),
    activa: false,
    reloj: 0,
    relojSintonia: 0,
    pintado: false,
  };
  const audio = new Audio();
  audio.preload = 'none';

  const $ = (sel, raiz = document) => raiz.querySelector(sel);
  const app = () => window.DoofApp || {};
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const norm = (t) => String(t || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const reducido = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function leerAhorro() { try { return localStorage.getItem(CLAVE_AHORRO) === '1'; } catch (e) { return false; } }
  function guardarAhorro(v) { try { localStorage.setItem(CLAVE_AHORRO, v ? '1' : '0'); } catch (e) { /* sin almacenamiento: dura la sesión */ } }

  const haceTexto = (ts) => {
    const s = Math.max(1, Math.round(Date.now() / 1000 - ts));
    if (s < 60) return `hace ${s} s`;
    const m = Math.round(s / 60);
    return m < 60 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`;
  };
  const hace = (ts) => ts ? `<time data-ts="${ts}">${haceTexto(ts)}</time>` : '';

  // Lo que le queda a la canción: Doof sabe cuándo termina (offset de Shazam + duración de iTunes) y la barra avanza aquí sola,
  // sin pedirle nada. Al terminar dice "terminando…" en vez de dejar el título viejo como si siguiera.
  const minSeg = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  // El saldo de la voz de Doof (API de Fish Audio, no se recarga solo): Javier pidió un medidor (17 nov 2026). La barra va contra el
  // 1.0 con que empezó la cuenta; con menos de 0.15 el especial automático ya no arranca, y se avisa.
  const medidorVoz = (m) => {
    if (!m) return '';
    const pct = Math.max(0, Math.min(100, m.saldo * 100));
    const bajo = m.saldo < 0.15;
    return `<div class="radio-voz-saldo${bajo ? ' radio-voz-saldo-bajo' : ''}"><span class="radio-progreso-pista"><i style="width:${pct}%"></i></span>
      <small>🎙 Voz de Doof: ${m.saldo.toFixed(2)} · ~${m.especiales} especiales${bajo ? ' · sin saldo para el especial diario' : ''}</small></div>`;
  };
  const barraCancion = (r) => (r.fin_estimado && r.duracion)
    ? `<div class="radio-progreso" data-id="${esc(r.id)}" data-fin="${r.fin_estimado}" data-dur="${r.duracion}"><span class="radio-progreso-pista"><i></i></span><span class="radio-progreso-texto"></span></div>`
    : '';
  function moverBarras() {
    const ahora = Date.now() / 1000;
    document.querySelectorAll('#vista-radio .radio-progreso').forEach((el) => {
      const queda = +el.dataset.fin - ahora;
      el.querySelector('i').style.width = `${Math.min(100, Math.max(0, (1 - queda / +el.dataset.dur) * 100))}%`;
      el.querySelector('.radio-progreso-texto').textContent = queda > 0 ? `queda ${minSeg(queda)}` : 'terminando…';
      el.classList.toggle('termino', queda <= 0);
      // Las favoritas las relee Doof solo; una del directorio sintonizada se le pide al terminar (una vez por canción).
      const r = porId(el.dataset.id);
      if (queda < -8 && r && !r.favorita && R.sintonizada === r.id && !R.consultando.has(r.id) && R.pedidoAlTerminar !== el.dataset.fin) {
        R.pedidoAlTerminar = el.dataset.fin;
        pedirQueEscuche(r.id);
      }
    });
  }

  const I = {
    play: '<svg viewBox="0 0 24 24"><path d="M7 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L8.5 4.64A1 1 0 0 0 7 5.5z"/></svg>',
    pausa: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    corazon: '<svg class="radio-i" viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
    estrella: '<svg class="radio-i" viewBox="0 0 24 24"><path d="M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z"/></svg>',
    campana: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"/></svg>',
    afuera: '<svg class="radio-i" viewBox="0 0 24 24"><path d="M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4"/></svg>',
    lupa: '<svg class="radio-i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/></svg>',
    cerrar: '<svg class="radio-i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    izq: '<svg class="radio-i" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    der: '<svg class="radio-i" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  };
  const ONDAS = (clase = '') => `<div class="radio-ondas ${clase}" aria-hidden="true"><i></i><i></i><i></i><i></i></div>`;

  // ---------------------------------------------------------------- datos
  const favoritas = () => (R.datos && R.datos.favoritas) || [];
  const directorio = () => (R.datos && R.datos.directorio) || [];
  const todas = () => favoritas().concat(directorio());
  const porId = (id) => todas().find((r) => r.id === id) || null;
  const enDial = () => todas().filter((r) => r.dial).sort((a, b) => parseFloat(a.dial) - parseFloat(b.dial));
  const cancion = (r) => (r && r.estado === 'match' && r.titulo) ? { titulo: r.titulo, artista: r.artista } : null;

  async function cargar() {
    if (!app().api) return;
    try {
      const datos = await app().api('/radio', {}, 20000, true);
      const primera = !R.datos;
      R.datos = datos;
      R.cargadoEn = Date.now();
      R.falla = '';
      R.consultando = new Set(todas().filter((r) => r.consultando).map((r) => r.id));
      if (primera || !porId(R.sintonizada)) elegirAlEntrar();
    } catch (e) {
      R.falla = e && e.sinRed ? 'Sin conexión con la PC' : (e && e.message) || 'No pude leer las radios';
    }
    pintar();
    pintarMosaico();
    if (R.sonando && R.datos) actualizarSesionMedia();      // también la pantalla de bloqueo, no solo la lista
  }

  function elegirAlEntrar() {
    // Al entrar, la aguja ya está en lo mejor que suena: lo que suena (si estás escuchando), algo de tus gustos, o cualquier canción.
    const favs = favoritas();
    const r = (R.sonando && porId(R.sonando) && porId(R.sonando).dial ? porId(R.sonando) : null)
      || favs.find((x) => x.estado === 'match' && x.gusta && x.dial)
      || favs.find((x) => x.estado === 'match' && x.dial) || enDial()[0];
    R.sintonizada = r ? r.id : null;
    R.saltoPendiente = true;
  }

  function evento(datos) {
    if (!datos) return;
    if (datos.panel) { if (R.activa) cargar(); return; }
    const nueva = datos.radio;
    if (!nueva || !R.datos) return;
    const lista = nueva.favorita ? R.datos.favoritas : R.datos.directorio;
    const i = lista.findIndex((r) => r.id === nueva.id);
    const antes = i >= 0 ? lista[i] : null;
    if (i >= 0) lista[i] = nueva; else lista.push(nueva);
    // Alguien saltó la canción de RadioDoof desde otro lado (la PC, el teléfono, el chat): lo que este <audio> ya bajó es de la
    // canción vieja, así que se vuelve a conectar para entrar a la nueva.
    if (nueva.propia && nueva.salto && antes && nueva.salto !== antes.salto && nueva.salto !== R.saltoVisto) {
      R.saltoVisto = nueva.salto;
      if (R.sonando === nueva.id && !R.pausado) { R.reintentos = 0; cancelarReconexion(); conectarAudio(nueva, false); }
    }
    if (nueva.consultando) R.consultando.add(nueva.id); else R.consultando.delete(nueva.id);
    const cambio = !antes || antes.estado !== nueva.estado || antes.titulo !== nueva.titulo;
    if (cambio) {
      R.nuevos.add(nueva.id);
      setTimeout(() => { R.nuevos.delete(nueva.id); }, 2500);
      if (nueva.estado === 'match' && nueva.gusta && nueva.id !== R.sintonizada && R.activa && app().avisar) {
        app().avisar(`Empezó ${nueva.artista} en ${nueva.dial || ''} ${nueva.nombre}`.replace(/\s+/g, ' '), 'Ir', () => sintonizar(nueva.id, true));
      }
    }
    if (nueva.id === R.sonando) actualizarSesionMedia();
    pintar();
    pintarMosaico();
  }

  // ---------------------------------------------------------------- escuchar
  async function escuchar(id) {
    const r = porId(id);
    if (!r) return;
    if (R.sonando === id && !R.cargandoAudio) {
      if (audio.paused) reanudar(); else pausar();
      return;
    }
    R.sonando = id;
    R.pausado = false;
    R.reintentos = 0;
    await conectarAudio(r, !R.ahorro && !!r.directo);
  }

  async function conectarAudio(r, directo) {
    const intento = ++R.intento;
    const vigente = () => intento === R.intento && R.sonando === r.id;
    R.cargandoAudio = true;
    R.conectandoDesde = Date.now();
    pintar();
    try {
      if (directo) {
        audio.src = r.directo;
      } else {
        const pase = await app().api('/radio/pase', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: r.id, baja: R.ahorro }) });
        if (!vigente()) return;
        audio.src = (app().base ? app().base() : '') + pase.ruta;
      }
      audio.dataset.directo = directo ? '1' : '';
      await audio.play();
    } catch (e) {
      if (!vigente()) return;           // la reemplazó otra conexión (su play() se aborta): no es una falla
      if (e && e.name === 'NotAllowedError') { R.pausado = true; }
      else if (directo) { R.cargandoAudio = false; return await conectarAudio(r, false); }      // el https directo falló: por la PC
      else { R.cargandoAudio = false; reconectar(); }       // antes se rendía con un aviso: ahora reintenta hasta que vuelva
    } finally {
      if (vigente()) R.cargandoAudio = false;
      actualizarSesionMedia();
      pintar();
      pintarMosaico();
    }
  }

  function cancelarReconexion() {
    clearTimeout(R.reconexion);
    R.reconexion = 0;
  }

  function pausar() {
    R.pausado = true;
    cancelarReconexion();
    audio.pause();
    pintar();
  }

  // Una radio en vivo pausada un rato ya no tiene conexión del otro lado (la PC la soltó): darle play otra vez al mismo <audio> la
  // dejaba muda. Se vuelve a conectar y entra a lo que suena ahora.
  function reanudar() {
    const r = porId(R.sonando);
    if (!r) return;
    R.pausado = false;
    R.reintentos = 0;
    cancelarReconexion();
    conectarAudio(r, !R.ahorro && !!r.directo);
  }

  function detener() {
    cancelarReconexion();
    R.intento += 1;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    R.sonando = null;
    R.pausado = false;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
    pintar();
    pintarMosaico();
  }

  // Cambios de red (Wi-Fi -> datos), una radio que se corta: vuelve a conectar sola en vez de quedarse muda.
  // Sin tope de intentos: un cambio de Wi-Fi a datos puede tardar más de medio minuto. Se deja de intentar solo si Javier pausa o
  // cambia de radio.
  function reconectar(inmediato) {
    const r = porId(R.sonando);
    if (!r || R.pausado) return;
    if (R.reconexion) {
      if (!inmediato) return;
      cancelarReconexion();
    }
    if (!R.cortadoDesde) R.cortadoDesde = Date.now();
    if (!R.avisadoCorte && Date.now() - R.cortadoDesde > AVISO_CORTE_MS && app().avisar) {
      R.avisadoCorte = true;
      app().avisar(r.nombre + ' se cortó: sigo intentando');
    }
    R.reintentos += 1;
    const espera = inmediato ? 0 : Math.min(1500 * R.reintentos, ESPERA_MAX_REINTENTO_MS);
    R.reconexion = setTimeout(() => {
      R.reconexion = 0;
      if (R.sonando === r.id && !R.pausado) conectarAudio(r, !R.ahorro && !!r.directo && audio.dataset.directo === '1');
    }, espera);
  }
  audio.addEventListener('error', () => { if (R.sonando && !R.cargandoAudio) reconectar(); });
  audio.addEventListener('ended', () => { if (R.sonando) reconectar(); });
  audio.addEventListener('playing', () => {
    R.reintentos = 0; R.pausado = false; R.cortadoDesde = 0; R.avisadoCorte = false; R.ultimoAvance = Date.now();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    pintar();
  });

  // El vigilante: si el audio dice que suena pero no avanza (o lleva demasiado conectando), el stream murió sin avisar.
  setInterval(() => {
    const ahora = Date.now();
    if (!R.sonando || R.pausado || R.reconexion) { R.ultimoAvance = ahora; return; }
    if (R.cargandoAudio) {
      if (ahora - R.conectandoDesde > CONECTANDO_MAX_MS) { R.intento += 1; R.cargandoAudio = false; reconectar(true); }
      return;
    }
    if (audio.paused) { R.ultimoAvance = ahora; return; }      // lo pausó el sistema (una llamada): no se reconecta encima
    if (audio.currentTime !== R.ultimoTiempo) { R.ultimoTiempo = audio.currentTime; R.ultimoAvance = ahora; return; }
    if (ahora - R.ultimoAvance > SILENCIO_MAX_MS) { R.ultimoAvance = ahora; reconectar(true); }
  }, 3000);
  // Volvió la red (Wi-Fi -> datos) o Javier volvió a la app con la radio muda: no se espera al vigilante.
  window.addEventListener('online', () => { if (R.sonando && !R.pausado) reconectar(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && R.sonando && !R.pausado && !R.cargandoAudio && !audio.paused && audio.readyState < 3) reconectar(true);
  });
  audio.addEventListener('pause', () => { if ('mediaSession' in navigator && R.sonando) navigator.mediaSession.playbackState = 'paused'; });

  async function saltarCancionDoof(boton) {
    if (boton) boton.disabled = true;
    try {
      const resp = await app().api('/radiodoof/saltar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      // El evento de este mismo salto puede llegar antes que la respuesta: si ya reconectó por él, no se reconecta dos veces.
      const yaReconecto = resp && resp.salto && R.saltoVisto === resp.salto;
      if (resp && resp.salto) R.saltoVisto = resp.salto;
      // RadioDoof manda 30 s por adelantado: lo que ya bajó es de la canción vieja. Se vuelve a conectar para entrar a la nueva.
      const r = porId('radiodoof');
      if (r && R.sonando === r.id && !R.pausado && !yaReconecto) { R.reintentos = 0; conectarAudio(r, false); }
    }
    catch (e) { if (app().avisar) app().avisar('No pude saltar: ' + (e.message || 'sin conexión')); }
    finally { if (boton) boton.disabled = false; }
  }

  function siguienteFavorita(paso) {
    const lista = favoritas().filter((r) => r.estado !== 'error_stream');
    if (!lista.length) return;
    const i = lista.findIndex((r) => r.id === R.sonando);
    const r = lista[(i + paso + lista.length) % lista.length];
    escuchar(r.id);
    if (r.dial) sintonizar(r.id, true);
  }

  // `forzada` ({titulo, artista}): la que ya debería estar sonando según el reloj, antes de que la PC lo confirme (ver programarCambio).
  function actualizarSesionMedia(forzada) {
    if (!('mediaSession' in navigator)) return;
    const r = porId(R.sonando);
    if (!r) return;
    const c = forzada || cancion(r);
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: c ? c.titulo : r.nombre,
        artist: c ? `${c.artista} · ${r.dial ? r.dial + ' ' : ''}${r.nombre}` : (r.dial ? r.dial + ' FM' : 'En vivo'),
        album: 'Radio · Doof',
        artwork: [{ src: 'static/iconos/icono-512.png', sizes: '512x512', type: 'image/png' }],
      });
    } catch (e) { /* navegador sin MediaMetadata */ }
    programarCambio();
  }

  // ---------------------------------------------------------------- en segundo plano (17 nov 2026)
  // Javier: "te sales de la app y deja de decirte qué canción está sonando; vuelves y tarda en actualizar". Con la app oculta no
  // llegaban los eventos (el long-polling espera a que sea visible) ni se recargaba la radio (solo con la sección a la vista). Mientras
  // algo suena: (1) RadioDoof avisa sola el cambio: ya se sabe cuándo termina la canción (fin_estimado) y cuál sigue, así que a ese
  // segundo la pantalla de bloqueo pasa a la siguiente y después se confirma con la PC; (2) cualquier radio se recarga cada
  // REFRESCO_MS aunque la app esté oculta. Chrome no frena los temporizadores de una página que está sonando.
  function programarCambio() {
    clearTimeout(R.relojCambio);
    const r = porId(R.sonando);
    if (!r || !r.propia || !r.fin_estimado) return;
    const ms = r.fin_estimado * 1000 - Date.now() + 1200;
    if (ms <= 0 || ms > 20 * 60 * 1000) return;
    R.relojCambio = setTimeout(() => {
      if (!R.sonando || R.pausado || audio.paused) return;
      const sig = (porId(R.sonando) || {}).siguiente;
      if (sig) actualizarSesionMedia({ titulo: sig.titulo, artista: sig.artista });
      cargar();
    }, ms);
  }
  setInterval(() => {
    if (R.sonando && !R.pausado && !audio.paused && (document.hidden || !R.activa)) cargar();
  }, REFRESCO_MS);
  if ('mediaSession' in navigator) {
    const accion = (nombre, fn) => { try { navigator.mediaSession.setActionHandler(nombre, fn); } catch (e) { /* acción no soportada */ } };
    accion('play', reanudar);
    accion('pause', pausar);
    accion('stop', detener);
    accion('nexttrack', () => { const r = porId(R.sonando); if (r && r.propia) saltarCancionDoof(); else siguienteFavorita(1); });
    accion('previoustrack', () => siguienteFavorita(-1));
  }

  // ---------------------------------------------------------------- sintonizar
  const xDe = (dial) => (parseFloat(dial) - F_MIN) * PX_MHZ;
  const fDe = (x) => F_MIN + x / PX_MHZ;

  function cercana(x) {
    const f = fDe(x);
    let mejor = null;
    let d = Infinity;
    enDial().forEach((r) => { const dd = Math.abs(parseFloat(r.dial) - f); if (dd < d) { d = dd; mejor = r; } });
    return d <= 0.15 ? mejor : null;
  }

  function sintonizar(id, mover) {
    const r = porId(id);
    if (!r) return;
    R.sintonizada = id;
    const dial = $('#radio-dial');
    if (mover && dial && r.dial) dial.scrollTo({ left: xDe(r.dial), behavior: reducido() ? 'auto' : 'smooth' });
    pintar();
    pedirQueEscuche(id);
  }

  function pedirQueEscuche(id) {
    clearTimeout(R.relojSintonia);
    R.relojSintonia = setTimeout(async () => {
      if (R.sintonizada !== id && R.sonando !== id) return;
      const r = porId(id);
      if (!r || r.estado === 'error_stream' && r.ts && Date.now() / 1000 - r.ts < 60) return;
      try {
        const res = await app().api('/radio/consultar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }, 15000, true);
        if (res.en_curso) {
          R.consultando.add(id);
          setTimeout(() => { if (R.consultando.delete(id)) pintar(); }, 40000);    // por si el evento nunca llega
          pintar();
        }
      } catch (e) { /* sin red: lo que se sabía sigue a la vista */ }
    }, ESPERA_SINTONIA_MS);
  }

  function saltar(paso) {
    const lista = enDial();
    const dial = $('#radio-dial');
    if (!lista.length || !dial) return;
    const f = fDe(dial.scrollLeft);
    const r = paso > 0 ? lista.find((x) => parseFloat(x.dial) > f + 0.05) : lista.slice().reverse().find((x) => parseFloat(x.dial) < f - 0.05);
    if (r) sintonizar(r.id, true);
  }

  // ---------------------------------------------------------------- pintar
  function botonPlay(r) {
    const activa = R.sonando === r.id && !R.pausado;
    const sinSenal = r.estado === 'error_stream';
    return `<button class="radio-play${activa ? ' sonando' : ''}" type="button" data-play="${esc(r.id)}"${sinSenal ? ' disabled' : ''}
      aria-label="${activa ? 'Pausar' : 'Escuchar'} ${esc(r.dial)} ${esc(r.nombre)}">${activa ? I.pausa : I.play}</button>`;
  }
  function botonEstrella(r) {
    if (r.propia) return '';            // RadioDoof es de Doof: siempre está, no se quita de favoritas
    const on = !!r.favorita;
    return `<button class="radio-estrella${on ? ' on' : ''}" type="button" data-estrella="${esc(r.id)}" aria-pressed="${on}"
      aria-label="${on ? 'Quitar de favoritas' : 'Agregar a favoritas'} ${esc(r.dial)} ${esc(r.nombre)}">${I.estrella}</button>`;
  }
  function enlaceSpotify(c) {
    if (!c) return '';
    const clave = norm(c.artista + '|' + c.titulo);
    const href = R.spotify.get(clave) || ('https://open.spotify.com/search/' + encodeURIComponent(c.artista + ' ' + c.titulo));
    return `<a class="radio-spotify" href="${esc(href)}" target="_blank" rel="noopener" data-spotify="${esc(clave)}">${I.afuera}Abrir en Spotify</a>`;
  }
  async function buscarEnlaceSpotify(c) {
    const clave = norm(c.artista + '|' + c.titulo);
    if (R.spotify.has(clave)) return;
    R.spotify.set(clave, '');
    try {
      const res = await app().api('/radio/spotify?' + new URLSearchParams({ artista: c.artista, titulo: c.titulo }), {}, 15000, true);
      if (res.url) {
        R.spotify.set(clave, res.url);
        document.querySelectorAll(`[data-spotify="${CSS.escape(clave)}"]`).forEach((a) => { a.href = res.url; });
      }
    } catch (e) { R.spotify.delete(clave); }
  }

  function textoDeEstado(r) {
    // [principal, secundaria(html), pie(html)]
    if (r.estado === 'match') {
      const et = r.gusta ? `<i class="radio-etiqueta">${I.corazon}${r.gusta === 'spotify' ? 'Spotify' : 'te gusta'}</i>` : '';
      if (r.propia) return [esc(r.titulo), `<em>${esc(r.artista)}</em>`, r.bumper ? 'Doof al micrófono' : `Tu música${r.familia ? ' · ' + esc(r.familia) : ''}`];
      return [esc(r.titulo), `<em>${esc(r.artista)}</em>${et}`, `Reconocida ${hace(r.ts)}`];
    }
    if (r.estado === 'error_stream') return ['Sin señal', '<em>La radio no está mandando audio</em>', r.ts ? `Probé ${hace(r.ts)}` : ''];
    if (r.estado === 'error_shazam') return ['No la pude identificar', '<em>Shazam falló esta vez</em>', hace(r.ts)];
    if (r.estado === 'sin_match') {
      const u = r.ultima;
      return ['Hablan, anuncios o algo que no reconozco', u ? `<em>Lo último: ${esc(u.titulo)} · ${esc(u.artista)}</em>` : '<em>Todavía no le reconocí nada</em>', u ? hace(u.ts) : hace(r.ts)];
    }
    return [r.favorita ? 'Todavía no la escuché' : esc(r.nombre), r.favorita ? '<em>Ya viene</em>' : '', ''];
  }

  function filaRadio(r) {
    const [principal, secundaria, pie] = textoDeEstado(r);
    const consultando = R.consultando.has(r.id);
    const clase = ['radio-fila', r.estado === 'match' ? '' : r.estado === 'error_stream' ? 'mal' : 'sin',
      R.sintonizada === r.id ? 'marcada' : '', R.nuevos.has(r.id) ? 'nuevo' : ''].join(' ');
    const sub = r.favorita ? r.nombre : (r.dial ? 'Valencia' : 'Solo internet');
    const dial = r.dial
      ? `<button class="radio-fila-dial" type="button" data-sintonizar="${esc(r.id)}" aria-label="Llevar el dial a ${esc(r.dial)}">${esc(r.dial)}<small>${esc(sub)}</small></button>`
      : `<div class="radio-fila-dial">Web<small>${esc(sub)}</small></div>`;
    let cuerpo;
    if (!r.favorita && !r.estado && !consultando) {
      cuerpo = `<b>${esc(r.nombre)}</b><button class="radio-que-suena" type="button" data-consultar="${esc(r.id)}">¿Qué suena?</button>`;
    } else if (consultando && !r.estado) {
      cuerpo = `<b>${r.favorita ? principal : esc(r.nombre)}</b><span><em>Escuchando unos segundos…</em></span>`;
    } else {
      cuerpo = `<b>${principal}</b><span>${secundaria}</span>${pie || consultando ? `<small>${pie}${consultando ? ' · <em class="radio-comprobando">comprobando…</em>' : ''}</small>` : ''}`;
      if (!r.favorita && r.estado === 'match') cuerpo = cuerpo.replace('<small>', `<small>${esc(r.nombre)} · `);
    }
    return `<li class="${clase}">${dial}<div class="radio-fila-texto">${cuerpo}</div>
      <div class="radio-fila-botones">${botonEstrella(r)}${botonPlay(r)}</div></li>`;
  }

  function pintarSintonizada() {
    const caja = $('#radio-sintonizada');
    if (!caja) return;
    const r = porId(R.sintonizada);
    $('#radio-sintonizador').classList.toggle('tuya', !!(r && r.estado === 'match' && r.gusta));
    caja.classList.toggle('nuevo', !!r && R.nuevos.has(r.id));
    if (!r) {
      caja.innerHTML = '<div class="radio-sintonizada-texto sin"><b>Aquí no hay ninguna radio</b><small>Desliza hasta un punto o usa las flechas.</small></div>';
      return;
    }
    const activa = R.sonando === r.id && !R.pausado;
    const cargandoEsta = R.sonando === r.id && R.cargandoAudio;
    const boton = `<button class="radio-boton primario" type="button" data-play="${esc(r.id)}"${r.estado === 'error_stream' ? ' disabled' : ''}>
      ${cargandoEsta ? 'Conectando…' : (activa ? I.pausa + 'Pausar' : I.play + 'Escuchar')}</button>`;
    const consultando = R.consultando.has(r.id);
    const c = cancion(r);
    let texto;
    if (consultando && !r.estado) {
      texto = `<div class="radio-sintonizada-texto sin"><div class="radio-escuchando">${ONDAS('ambar')}<b>Escuchando qué suena…</b></div><small>Unos segundos y te digo</small></div>`;
    } else if (c) {
      const origen = r.origen ? ` · está en ${esc(r.origen)}` : r.gusta ? ' · está en tus gustos' : '';
      texto = `<div class="radio-sintonizada-texto">${r.gusta ? `<div class="radio-tuya">${I.corazon}Es de lo tuyo</div>` : ''}<b>${esc(c.titulo)}</b><span>${esc(c.artista)}</span>
        ${barraCancion(r)}<small>Reconocida ${hace(r.ts)}${origen}${r.favorita ? '' : ' · no es favorita'}${consultando ? ' · <em class="radio-comprobando">comprobando…</em>' : ''}</small></div>`;
      if (r.propia) {
        const sig = r.siguiente ? `Después: ${esc(r.siguiente.titulo)} · ${esc(r.siguiente.artista)}` : 'Tu música, mezclada por Doof';
        texto = `<div class="radio-sintonizada-texto">${r.bumper ? '<div class="radio-tuya">Doof al micrófono · después suena</div>' : ''}<b>${esc(c.titulo)}</b><span>${esc(c.artista)}</span>
          ${r.bumper ? '' : barraCancion(r)}<small>${sig}${r.programa ? ' · 🎙 ' + esc(r.programa) : r.pedido ? ' · a pedido: ' + esc(r.pedido) : (r.familia ? ' · ' + esc(r.familia) : '')}</small>${medidorVoz(r.voz_saldo)}</div>`;
      }
      buscarEnlaceSpotify(c);
    } else {
      const [principal, , pie] = textoDeEstado(r);
      const u = r.estado === 'sin_match' && r.ultima ? `Lo último: ${esc(r.ultima.titulo)} · ${esc(r.ultima.artista)}, ${hace(r.ultima.ts)}` : pie;
      const clase = r.estado === 'error_stream' ? 'mal' : 'sin';
      texto = `<div class="radio-sintonizada-texto ${clase}"><b>${principal}</b><small>${u || ''}${consultando ? ' · <em class="radio-comprobando">comprobando…</em>' : ''}</small></div>`;
    }
    const saltarDoof = r.propia && c ? `<button class="radio-boton" type="button" data-saltar-doof>${I.der}Saltar</button>` : '';
    caja.innerHTML = `${texto}<div class="radio-sintonizada-botones">${boton}${saltarDoof}<div class="radio-fila-mini">${c ? enlaceSpotify(c) : ''}${botonEstrella(r)}</div></div>`;
    moverBarras();
  }

  function pintarDial() {
    const escala = $('#radio-escala');
    if (!escala) return;
    let html = '';
    for (let n = 88; n <= 108; n++) html += `<span class="radio-mhz" style="left:${xDe(n)}px">${n}</span>`;
    html += enDial().map((r) => {
      const clase = r.propia ? 'propia' : !r.favorita ? 'otra' : r.estado === 'error_stream' ? 'mal' : r.estado === 'match' ? (r.gusta ? 'tuya' : 'musica') : '';
      return `<button class="radio-estacion ${clase}${R.sintonizada === r.id ? ' en-aguja' : ''}${R.nuevos.has(r.id) ? ' nuevo' : ''}" type="button" tabindex="-1"
        style="left:${xDe(r.dial)}px" data-sintonizar="${esc(r.id)}" aria-label="${esc(r.dial)} ${esc(r.nombre)}"><span>${esc(r.dial)}</span><i></i></button>`;
    }).join('');
    escala.innerHTML = html;
    const dial = $('#radio-dial');
    const r = porId(R.sintonizada);
    if (R.saltoPendiente && r && r.dial && dial.clientWidth) {
      R.saltoPendiente = false;
      dial.scrollLeft = xDe(r.dial);
    }
    pintarLectura();
  }

  function pintarLectura() {
    const dial = $('#radio-dial');
    if (!dial) return;
    const f = Math.min(108, Math.max(F_MIN, fDe(dial.scrollLeft)));
    const r = cercana(dial.scrollLeft);
    $('#radio-mhz-num').innerHTML = `${f.toFixed(1)}<small>MHz</small>`;
    $('#radio-mhz-nombre').textContent = r ? r.nombre : 'Sin radio aquí';
    $('#radio-frecuencia').classList.toggle('vacia', !r);
  }

  function pintarBusqueda() {
    const q = norm(R.busqueda);
    const v = R.datos ? R.datos.vigia : {};
    $('#radio-limpiar').hidden = !q;
    const sug = (R.datos && R.datos.sugerencias) || [];
    $('#radio-sugerencias').innerHTML = !q && !v.buscando && sug.length
      ? '<small>De tus gustos y tu Spotify</small>' + sug.map((s) => `<button type="button" data-sugerencia="${esc(s)}">${esc(s)}</button>`).join('') : '';
    const caja = $('#radio-resultado');
    if (!q) caja.innerHTML = '';
    else {
      const suenan = todas().filter((r) => { const c = cancion(r); return c && (norm(c.artista).includes(q) || norm(c.titulo).includes(q)); });
      const radios = todas().filter((r) => norm(r.nombre).includes(q) || (r.dial && r.dial.startsWith(q)));
      if (suenan.length) {
        caja.innerHTML = `<div class="radio-resultado"><h4>Está sonando ahora</h4>${suenan.map((r) => {
          const c = cancion(r);
          return `<div class="radio-coincidencia"><div><b>${esc(c.titulo)} · ${esc(c.artista)}</b><span>en <strong>${esc(r.dial)}</strong> ${esc(r.nombre)} · ${hace(r.ts)}</span>${enlaceSpotify(c)}</div>${botonPlay(r)}</div>`;
        }).join('')}</div>`;
      } else if (radios.length) {
        caja.innerHTML = `<div class="radio-resultado"><h4>Radios</h4>${radios.slice(0, 5).map((r) => `
          <div class="radio-coincidencia"><div><b>${esc(r.dial ? r.dial + ' ' : '')}${esc(r.nombre)}</b><span>${r.favorita ? 'En tus favoritas' : r.dial ? 'Valencia' : 'Solo internet'}</span></div>${botonPlay(r)}</div>`).join('')}</div>`;
      } else {
        caja.innerHTML = `<div class="radio-resultado"><h4>Ahora no suena</h4>
          <p>Ninguna de tus ${favoritas().length} favoritas está poniendo <b>${esc(R.busqueda.trim())}</b> en este momento.</p>
          <div class="radio-acciones"><button class="radio-boton primario campana" type="button" data-avisar>${I.campana}Avisarme cuando suene</button></div></div>`;
      }
    }
    $('#radio-buscando').innerHTML = v.buscando ? `<div class="radio-buscando" role="status"><span class="radio-radar" aria-hidden="true"></span>
      <div><b>Buscando «${esc(v.buscando)}»</b><small>En tus favoritas hasta las ${esc(v.hasta)}. Te aviso al teléfono apenas suene.</small></div>
      <button type="button" data-cancelar-busqueda>Cancelar</button></div>` : '';
  }

  function pintarListas() {
    const favs = favoritas();
    const conMusica = favs.filter((r) => r.estado === 'match').sort((a, b) => (b.gusta ? 1 : 0) - (a.gusta ? 1 : 0));
    const sin = favs.filter((r) => r.estado !== 'match').sort((a, b) => (a.estado === 'error_stream') - (b.estado === 'error_stream'));
    const dir = directorio();
    $('#radio-n-fav').textContent = favs.length;
    $('#radio-n-mas').textContent = dir.length || '';
    $('#radio-tab-fav').setAttribute('aria-selected', String(R.pestana === 'fav'));
    $('#radio-tab-mas').setAttribute('aria-selected', String(R.pestana === 'mas'));
    $('#radio-panel-fav').hidden = R.pestana !== 'fav';
    $('#radio-panel-mas').hidden = R.pestana !== 'mas';
    $('#radio-lista-musica').innerHTML = conMusica.map(filaRadio).join('') || '<li class="radio-vacio">Ninguna está poniendo una canción ahora mismo.</li>';
    $('#radio-cuenta-musica').textContent = conMusica.length;
    $('#radio-lista-sin').innerHTML = sin.map(filaRadio).join('');
    $('#radio-cuenta-sin').textContent = sin.length;
    $('#radio-sub-sin').hidden = !sin.length;
    $('#radio-lista-mas').innerHTML = dir.length ? dir.map(filaRadio).join('')
      : `<li class="radio-vacio">${R.datos && R.datos.directorio_listo ? 'No encontré más radios de Valencia que estén transmitiendo.' : 'Estoy buscando las radios de Valencia en el directorio. La primera vez tarda un minuto; aparecen solas.'}</li>`;
  }

  function pintarEstado() {
    const caja = $('#radio-estado');
    if (R.falla) { caja.className = 'radio-estado mal'; caja.innerHTML = `<i></i><span>${esc(R.falla)}</span>`; return; }
    if (!R.datos) { caja.className = 'radio-estado'; caja.innerHTML = '<i></i><span>Preguntándole a Doof…</span>'; return; }
    const favs = favoritas();
    const conMusica = favs.filter((r) => r.estado === 'match').length;
    const ultima = Math.max(0, ...favs.map((r) => r.ts || 0));
    const v = R.datos.vigia;
    caja.className = 'radio-estado vivo';
    caja.innerHTML = `<i></i><span>En vivo · ${conMusica} de ${favs.length} con música${ultima ? ' · última lectura ' + hace(ultima) : ' · escuchando…'}${v.activo && !v.buscando ? ' · vigía hasta las ' + esc(v.hasta) : ''}</span>`;
  }

  function pintarInterruptores() {
    const v = (R.datos && R.datos.vigia) || {};
    const vig = $('#radio-vigia');
    vig.classList.toggle('activo', !!v.activo);
    vig.setAttribute('aria-pressed', String(!!v.activo));
    $('#radio-vigia-detalle').textContent = v.activo
      ? (v.buscando ? `Buscando «${v.buscando}» hasta las ${v.hasta}` : `Prendido hasta las ${v.hasta} · te aviso al teléfono`)
      : 'Apagado · se prende por 2 horas';
    const ah = $('#radio-ahorro');
    ah.classList.toggle('activo', R.ahorro);
    ah.setAttribute('aria-pressed', String(R.ahorro));
  }

  function pintarReproductor() {
    const caja = $('#radio-reproductor');
    const r = porId(R.sonando);
    caja.hidden = !r;
    if (!r) return;
    const c = cancion(r);
    $('#radio-repro-ondas').className = 'radio-ondas' + (R.pausado || R.cargandoAudio ? ' quietas' : '');
    $('#radio-repro-dial').textContent = `${r.dial ? r.dial + ' ' : ''}${r.nombre}`;
    $('#radio-repro-cancion').textContent = R.cargandoAudio ? 'Conectando…' : c ? `${c.titulo} · ${c.artista}` : (R.ahorro ? 'En vivo · ahorro de datos' : 'En vivo');
    $('#radio-repro-pausa').innerHTML = (R.pausado ? I.play : I.pausa).replace('<svg', '<svg class="radio-i"');
    $('#radio-repro-pausa').setAttribute('aria-label', R.pausado ? 'Seguir escuchando' : 'Pausar');
  }

  function recordarFoco() {
    const a = document.activeElement;
    if (!a || !$('#vista-radio') || !$('#vista-radio').contains(a) || a.id === 'radio-buscar') return null;
    for (const attr of ['data-play', 'data-estrella', 'data-sintonizar', 'data-consultar']) {
      if (a.hasAttribute(attr)) {
        const sel = `#vista-radio [${attr}="${CSS.escape(a.getAttribute(attr))}"]`;
        return { sel, i: Array.from(document.querySelectorAll(sel)).indexOf(a) };
      }
    }
    return null;
  }

  function pintar() {
    if (!R.pintado || !$('#radio-contenido')) return;
    const foco = recordarFoco();
    pintarEstado();
    pintarDial();
    pintarSintonizada();
    const tuyas = favoritas().filter((r) => r.estado === 'match' && r.gusta && r.dial && r.id !== R.sintonizada);
    $('#radio-tambien').innerHTML = tuyas.length ? '<span>También de lo tuyo:</span>' + tuyas.map((r) =>
      `<button type="button" data-sintonizar="${esc(r.id)}"><i></i><b>${esc(r.dial)}</b>${esc(r.nombre)}</button>`).join('') : '';
    pintarBusqueda();
    pintarListas();
    pintarInterruptores();
    pintarReproductor();
    if (foco) { const el = document.querySelectorAll(foco.sel)[foco.i]; if (el) el.focus({ preventScroll: true }); }
  }

  // Inicio: una fila más junto a PC y Luz. No pide nada a la PC (pedir el panel haría que Doof se ponga a escuchar): muestra lo último.
  function pintarMosaico() {
    const m = $('#mosaico-radio');
    if (!m) return;
    const r = porId(R.sonando);
    let clase = '';
    let valor = 'Radio';
    let detalle = 'Toca para ver qué suena';
    if (r) {
      clase = 'bien';
      valor = `Sonando ${r.dial ? r.dial + ' ' : ''}${r.nombre}`;
      const c = cancion(r);
      detalle = c ? `${c.titulo} · ${c.artista}` : (R.pausado ? 'En pausa' : 'En vivo');
    } else if (R.datos) {
      const favs = favoritas();
      const n = favs.filter((x) => x.estado === 'match').length;
      valor = `${n} de ${favs.length} con música`;
      const top = favs.find((x) => x.estado === 'match' && x.gusta);
      detalle = top ? `${top.dial} ${top.nombre}: ${top.artista}` : (R.datos.vigia.activo ? `Vigía hasta las ${R.datos.vigia.hasta}` : `Leído ${haceTexto(R.cargadoEn / 1000)}`);
      if (R.datos.vigia.activo) clase = 'espera';
    }
    m.className = 'mosaico' + (clase ? ' ' + clase : '');
    m.querySelector('.mosaico-valor').textContent = valor;
    m.querySelector('.mosaico-detalle').textContent = detalle;
  }

  // ---------------------------------------------------------------- armar la vista (una vez)
  function armar() {
    const caja = $('#radio-contenido');
    if (!caja || R.pintado) return;
    caja.innerHTML = `
      <p class="radio-estado" id="radio-estado" aria-live="polite"><i></i><span>Preguntándole a Doof…</span></p>
      <section class="radio-sintonizador" id="radio-sintonizador" aria-label="Sintonizador FM">
        <div class="radio-lectura">
          <button class="radio-saltar" type="button" id="radio-anterior" aria-label="Radio anterior">${I.izq}</button>
          <div class="radio-frecuencia" id="radio-frecuencia" aria-live="polite"><b id="radio-mhz-num">—<small>MHz</small></b><span id="radio-mhz-nombre"></span></div>
          <button class="radio-saltar" type="button" id="radio-siguiente" aria-label="Radio siguiente">${I.der}</button>
        </div>
        <div class="radio-marco">
          <div class="radio-dial" id="radio-dial" tabindex="0" aria-label="Desliza para sintonizar; flechas izquierda y derecha para cambiar de radio"><div class="radio-escala" id="radio-escala"></div></div>
          <div class="radio-aguja" aria-hidden="true"></div>
        </div>
        <div class="radio-sintonizada" id="radio-sintonizada"></div>
      </section>
      <div class="radio-tambien" id="radio-tambien"></div>

      <div class="radio-buscador">
        <label for="radio-buscar">${I.lupa}
          <input id="radio-buscar" type="search" placeholder="Busca un artista o una canción" autocomplete="off" spellcheck="false" enterkeyhint="search">
          <button class="radio-limpiar" type="button" id="radio-limpiar" aria-label="Borrar la búsqueda" hidden>${I.cerrar}</button>
        </label>
        <div class="radio-sugerencias" id="radio-sugerencias"></div>
        <div id="radio-resultado"></div>
        <div id="radio-buscando"></div>
      </div>

      <div class="radio-pestanas" role="tablist" aria-label="Qué radios ver">
        <button type="button" role="tab" id="radio-tab-fav" aria-selected="true">Favoritas<span id="radio-n-fav"></span></button>
        <button type="button" role="tab" id="radio-tab-mas" aria-selected="false">Más radios<span id="radio-n-mas"></span></button>
      </div>
      <div id="radio-panel-fav" role="tabpanel" aria-labelledby="radio-tab-fav">
        <h3 class="radio-subtitulo">Sonando ahora <span id="radio-cuenta-musica"></span></h3>
        <ul class="radio-lista" id="radio-lista-musica"></ul>
        <h3 class="radio-subtitulo" id="radio-sub-sin">Sin canción ahora <span id="radio-cuenta-sin"></span></h3>
        <ul class="radio-lista" id="radio-lista-sin"></ul>
      </div>
      <div id="radio-panel-mas" role="tabpanel" aria-labelledby="radio-tab-mas" hidden>
        <ul class="radio-lista" id="radio-lista-mas"></ul>
        <p class="casa-nota">Doof vigila solo tus favoritas. Estas se pueden escuchar y preguntar qué suenan. Con la estrella pasan a favoritas. Las que tienen frecuencia también salen en el dial, con el punto hueco.</p>
      </div>

      <div class="radio-interruptores">
        <button class="usdt-interruptor" type="button" id="radio-vigia" aria-pressed="false">
          <span class="usdt-interruptor-texto"><b>Avisarme si suena algo que me guste</b><small id="radio-vigia-detalle"></small></span>
          <i class="usdt-palanca"></i>
        </button>
        <button class="usdt-interruptor" type="button" id="radio-ahorro" aria-pressed="false">
          <span class="usdt-interruptor-texto"><b>Ahorro de datos</b><small>El audio pasa por la PC en menor calidad: unos 22 MB por hora en vez de 29 a 58</small></span>
          <i class="usdt-palanca"></i>
        </button>
      </div>
      <p class="casa-nota">El stream va como un minuto detrás de la FM del carro. Lo que suena lo reconoce la PC; el teléfono solo recibe el texto, y gasta datos solo mientras escuchas.</p>

      <div class="radio-reproductor" id="radio-reproductor" hidden>
        <div class="radio-ondas" id="radio-repro-ondas" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <div class="radio-repro-texto"><b id="radio-repro-dial"></b><span id="radio-repro-cancion"></span></div>
        <button class="radio-repro-boton principal" type="button" id="radio-repro-pausa" aria-label="Pausar"></button>
        <button class="radio-repro-boton" type="button" id="radio-repro-cerrar" aria-label="Dejar de escuchar">${I.cerrar}</button>
      </div>`;
    R.pintado = true;
    conectarEventos();
  }

  function conectarEventos() {
    const dial = $('#radio-dial');
    let finScroll = 0;
    dial.addEventListener('scroll', () => {
      pintarLectura();
      clearTimeout(finScroll);
      finScroll = setTimeout(() => {
        const c = cercana(dial.scrollLeft);
        const id = c ? c.id : null;
        if (id !== R.sintonizada) { R.sintonizada = id; pintar(); if (id) pedirQueEscuche(id); }
      }, 180);
    }, { passive: true });
    dial.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); saltar(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); saltar(-1); }
    });
    // Con mouse: arrastrar y la rueda mueven el dial (en el teléfono ya se desliza con el dedo).
    let arrastre = null;
    dial.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') return;
      arrastre = { x: e.clientX, izq: dial.scrollLeft, movio: false };
      dial.setPointerCapture(e.pointerId);
    });
    dial.addEventListener('pointermove', (e) => {
      if (!arrastre) return;
      const dx = e.clientX - arrastre.x;
      if (Math.abs(dx) > 3) { arrastre.movio = true; dial.classList.add('arrastrando'); }
      dial.scrollLeft = arrastre.izq - dx;
    });
    const soltar = () => {
      if (!arrastre) return;
      const movio = arrastre.movio;
      arrastre = null;
      dial.classList.remove('arrastrando');
      if (!movio) return;
      const f = fDe(dial.scrollLeft);
      const lista = enDial();
      if (!lista.length) return;
      const c = lista.reduce((a, b) => Math.abs(parseFloat(b.dial) - f) < Math.abs(parseFloat(a.dial) - f) ? b : a);
      sintonizar(c.id, true);
    };
    dial.addEventListener('pointerup', soltar);
    dial.addEventListener('pointercancel', soltar);
    dial.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); saltar(e.deltaY > 0 ? 1 : -1); }
    }, { passive: false });
    $('#radio-anterior').addEventListener('click', () => saltar(-1));
    $('#radio-siguiente').addEventListener('click', () => saltar(1));

    const buscar = $('#radio-buscar');
    buscar.addEventListener('input', () => { R.busqueda = buscar.value; pintarBusqueda(); });
    buscar.addEventListener('keydown', (e) => { if (e.key === 'Escape') { buscar.value = ''; R.busqueda = ''; pintarBusqueda(); } });
    $('#radio-limpiar').addEventListener('click', () => { buscar.value = ''; R.busqueda = ''; buscar.focus(); pintarBusqueda(); });

    $('#radio-tab-fav').addEventListener('click', () => { R.pestana = 'fav'; pintar(); });
    $('#radio-tab-mas').addEventListener('click', () => { R.pestana = 'mas'; pintar(); });
    $('#radio-repro-pausa').addEventListener('click', () => { if (R.sonando) escuchar(R.sonando); });
    $('#radio-repro-cerrar').addEventListener('click', detener);

    $('#radio-vigia').addEventListener('click', async (e) => {
      const boton = e.currentTarget;
      const activo = !(R.datos && R.datos.vigia.activo);
      boton.disabled = true;
      try {
        await app().api('/radio/modo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activo }) });
        await cargar();
      } catch (err) { if (app().avisar) app().avisar('No pude cambiar el vigía: ' + (err.message || 'sin conexión')); }
      boton.disabled = false;
    });
    $('#radio-ahorro').addEventListener('click', () => {
      R.ahorro = !R.ahorro;
      guardarAhorro(R.ahorro);
      pintar();
      const r = porId(R.sonando);
      if (r && !R.pausado) { R.reintentos = 0; conectarAudio(r, !R.ahorro && !!r.directo); }
    });

    $('#radio-contenido').addEventListener('click', async (e) => {
      const t = e.target;
      const sint = t.closest('[data-sintonizar]');
      if (sint) {
        sintonizar(sint.dataset.sintonizar, true);
        if (!t.closest('.radio-estacion')) $('#radio-sintonizador').scrollIntoView({ behavior: reducido() ? 'auto' : 'smooth', block: 'nearest' });
        return;
      }
      const play = t.closest('[data-play]');
      if (play) {
        const id = play.dataset.play;
        const r = porId(id);
        escuchar(id);
        if (r && r.dial && R.sintonizada !== id) sintonizar(id, true);
        else pedirQueEscuche(id);
        return;
      }
      const saltarDoof = t.closest('[data-saltar-doof]');
      if (saltarDoof) { saltarCancionDoof(saltarDoof); return; }
      const est = t.closest('[data-estrella]');
      if (est) {
        const r = porId(est.dataset.estrella);
        if (!r) return;
        est.disabled = true;
        try {
          await app().api('/radio/favorita', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: r.id, favorita: !r.favorita }) });
          if (app().avisar) app().avisar(r.favorita ? `${r.nombre} salió de favoritas` : `${r.nombre} agregada a favoritas`);
          await cargar();
        } catch (err) { if (app().avisar) app().avisar('No pude cambiar las favoritas: ' + (err.message || 'sin conexión')); est.disabled = false; }
        return;
      }
      const cons = t.closest('[data-consultar]');
      if (cons) { R.consultando.add(cons.dataset.consultar); pintar(); pedirQueEscuche(cons.dataset.consultar); R.sintonizada = R.sintonizada || cons.dataset.consultar; return; }
      const sug = t.closest('[data-sugerencia]');
      if (sug) { $('#radio-buscar').value = sug.dataset.sugerencia; R.busqueda = sug.dataset.sugerencia; pintarBusqueda(); return; }
      if (t.closest('[data-avisar]')) {
        const texto = R.busqueda.trim();
        try {
          await app().api('/radio/buscar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto }) });
          $('#radio-buscar').value = '';
          R.busqueda = '';
          if (app().avisar) app().avisar('Listo, te aviso cuando suene');
          await cargar();
        } catch (err) { if (app().avisar) app().avisar('No pude dejar la búsqueda: ' + (err.message || 'sin conexión')); }
        return;
      }
      if (t.closest('[data-cancelar-busqueda]')) {
        try { await app().api('/radio/buscar/cancelar', { method: 'POST' }); await cargar(); } catch (err) { /* se reintenta tocando otra vez */ }
      }
    });
  }

  // ---------------------------------------------------------------- entrar y salir
  function entrar() {
    armar();
    R.activa = true;
    if (R.datos) { elegirSiHaceFalta(); pintar(); }
    cargar();
    clearInterval(R.reloj);
    R.reloj = setInterval(() => { if (R.activa && !document.hidden) cargar(); }, REFRESCO_MS);
  }
  function elegirSiHaceFalta() { if (!porId(R.sintonizada)) elegirAlEntrar(); else R.saltoPendiente = true; }

  function salir() {
    R.activa = false;
    clearInterval(R.reloj);
  }

  // app.js marca la vista en <body data-vista>; mirar ese atributo evita tocar su navegación por todos lados.
  new MutationObserver(() => {
    const ahora = document.body.dataset.vista === 'radio';
    if (ahora && !R.activa) entrar();
    else if (!ahora && R.activa) salir();
  }).observe(document.body, { attributes: true, attributeFilter: ['data-vista'] });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && R.activa) cargar(); });
  setInterval(() => { document.querySelectorAll('#vista-radio [data-ts]').forEach((el) => { el.textContent = haceTexto(+el.dataset.ts); }); moverBarras(); }, 1000);
  setInterval(pintarMosaico, 30000);

  window.DoofRadio = { evento, entrar, salir };
  if (document.body.dataset.vista === 'radio') entrar();
  pintarMosaico();
})();
