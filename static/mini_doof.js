/* Charlene: hablarle a la Raspberry directo desde el teléfono, para cuando la PC está apagada y no hay puente ni túnel.

   Va por MQTT sobre WebSocket a dos brokers públicos: quien sea puede leer el tema, así que lo único que protege es el sobre AES-GCM. MQTT escrito a mano
   (lo poco que hace falta: conectar, suscribir, publicar sin QoS) porque la CSP de la app no carga scripts de fuera, y una librería entera sería más código que confiar.

   La llave la entrega el puente una vez, con huella, y queda en IndexedDB como CryptoKey no extraíble: se puede usar, pero ni este código puede volver a leerla. Sin PIN
   a propósito (decisión de Javier, 6 nov 2026): se abre en una emergencia. Lo que la protege es el bloqueo del teléfono, y encender pide confirmar en la interfaz. */
(() => {
  'use strict';

  // `guarda`: con sesión persistente (id fijo, sin "clean session"), EMQX guarda lo que la Pi publique mientras el teléfono no está conectado, y lo
  // entrega al volver. Medido el 14 nov 2026 con mensajes QoS 0 como los de la Pi: EMQX los guarda, HiveMQ no. Sin esto, salir de la app mientras
  // Charlene pensaba perdía la respuesta.
  const BROKERS = [{ url: 'wss://broker.emqx.io:8084/mqtt', guarda: true }, { url: 'wss://broker.hivemq.com:8884/mqtt', guarda: false }];
  const BASE_DE_DATOS = 'mini_doof';
  const VERSION_BASE = 2;
  const ALMACEN = 'llave';
  const ALMACEN_CHATS = 'chats';
  const CLAVE_LLAVE = 'actual';
  const MARCA_INSTALADA = 'mini_doof_instalada';    // IndexedDB es asíncrona, y la interfaz necesita saberlo al pintar
  const SOBRE_CON_PIN = 'mini_doof_sobre';          // versión anterior: una llave cifrada con PIN, que ya nadie va a abrir
  const CLAVE_ID = 'mini_doof_id';
  const ESPERA_PRIMER_BROKER_MS = 20000;   // medido con VPN: abrir el socket ya tarda hasta 4,3 s, y con 8 s de margen el menú fallaba a veces
  const ESPERA_SEGUNDO_BROKER_MS = 2500;
  const LATIDO_MS = 25000;
  const ESPERA_RESPUESTA_MS = 35000;       // "estado_pc" puede tardar si la Pi tiene que esperar a la PC
  const ESPERA_CHARLA_MS = 5 * 60 * 1000;  // en la Pi, el modelo puede tardar minutos
  const ALFABETO = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  const texto = new TextEncoder();
  const aB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const deB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const pausa = (ms) => new Promise((listo) => setTimeout(listo, ms));

  function alfanumerico(largo) {
    return Array.from(crypto.getRandomValues(new Uint8Array(largo)), (b) => ALFABETO[b % ALFABETO.length]).join('');
  }

  function leer(clave) {
    try { return localStorage.getItem(clave); } catch (e) { return null; }
  }

  function escribir(clave, valor) {
    try {
      if (valor) localStorage.setItem(clave, valor);
      else localStorage.removeItem(clave);
    } catch (e) { /* sin almacenamiento, la llave no queda instalada, e instalar lo dice */ }
  }

  // La Pi recuerda la charla por este id: tiene que ser el mismo en cada mensaje.
  function idDelTelefono() {
    let id = leer(CLAVE_ID);
    if (!id || !/^[A-Za-z0-9]{8,64}$/.test(id)) {
      id = alfanumerico(16);
      escribir(CLAVE_ID, id);
    }
    return id;
  }

  // ---------------------------------------------------------------- llave
  function abrirBase() {
    return new Promise((listo, fallar) => {
      const pedido = indexedDB.open(BASE_DE_DATOS, VERSION_BASE);
      // La versión 1 solo tenía la llave: subir de versión agrega los chats sin tocarla.
      pedido.onupgradeneeded = () => {
        const base = pedido.result;
        if (!base.objectStoreNames.contains(ALMACEN)) base.createObjectStore(ALMACEN);
        if (!base.objectStoreNames.contains(ALMACEN_CHATS)) base.createObjectStore(ALMACEN_CHATS, { keyPath: 'id' });
      };
      pedido.onsuccess = () => listo(pedido.result);
      pedido.onerror = () => fallar(pedido.error);
    });
  }

  const operarLlave = (modo, operar) => operarEn(ALMACEN, modo, operar);

  async function operarEn(almacenNombre, modo, operar) {
    const base = await abrirBase();
    try {
      return await new Promise((listo, fallar) => {
        const transaccion = base.transaction(almacenNombre, modo);
        const pedido = operar(transaccion.objectStore(almacenNombre));
        transaccion.oncomplete = () => listo(pedido.result);
        transaccion.onerror = () => fallar(transaccion.error);
        transaccion.onabort = () => fallar(transaccion.error);
      });
    } finally {
      base.close();
    }
  }

  async function temaDe(cruda) {
    const prefijo = texto.encode('mini-doof:');
    const junto = new Uint8Array(prefijo.length + cruda.length);
    junto.set(prefijo);
    junto.set(cruda, prefijo.length);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', junto));
    return 'mini-doof/' + Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  }

  async function instalar(claveB64) {
    const cruda = deB64(claveB64);
    if (cruda.length !== 32) throw new Error('Esa no es una llave de Charlene.');
    const tema = await temaDe(cruda);
    const llave = await crypto.subtle.importKey('raw', cruda, 'AES-GCM', false, ['encrypt', 'decrypt']);
    cruda.fill(0);
    await operarLlave('readwrite', (almacen) => almacen.put({ llave, tema }, CLAVE_LLAVE));
    escribir(MARCA_INSTALADA, '1');
    cerrar();
    // Sin esto, el sistema puede borrarla si le falta espacio: justo cuando haga falta, con la PC apagada no se podría reinstalar.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  function instalada() {
    return !!leer(MARCA_INSTALADA);
  }

  // ---------------------------------------------------------------- chats guardados
  // En el teléfono y no en la Pi: la Pi solo recuerda unos minutos de charla, y la app debe mostrarlos aunque la Raspberry esté caída.
  const chats = {
    listar: async () => ((await operarEn(ALMACEN_CHATS, 'readonly', (a) => a.getAll())) || []).sort((x, y) => (y.actualizado || '').localeCompare(x.actualizado || '')),
    leer: (id) => operarEn(ALMACEN_CHATS, 'readonly', (a) => a.get(id)),
    guardar: (chat) => operarEn(ALMACEN_CHATS, 'readwrite', (a) => a.put(chat)),
    borrar: (id) => operarEn(ALMACEN_CHATS, 'readwrite', (a) => a.delete(id)),
  };

  // ---------------------------------------------------------------- MQTT
  function cadena(valor) {
    const bytes = texto.encode(valor);
    return Uint8Array.from([bytes.length >> 8, bytes.length & 255, ...bytes]);
  }

  function paquete(primero, ...partes) {
    const largo = partes.reduce((suma, p) => suma + p.length, 0);
    const cabecera = [primero];
    let resto = largo;
    do {
      const byte = resto % 128;
      resto = Math.floor(resto / 128);
      cabecera.push(resto > 0 ? byte | 128 : byte);
    } while (resto > 0);
    const salida = new Uint8Array(cabecera.length + largo);
    salida.set(cabecera);
    let posicion = cabecera.length;
    for (const parte of partes) {
      salida.set(parte, posicion);
      posicion += parte.length;
    }
    return salida;
  }

  class Broker {
    constructor(url, temaSalida, alMensaje, idFijo) {
      this.listo = false;
      this.cerrado = false;
      this.temaSalida = temaSalida;
      this.alMensaje = alMensaje;
      this.buffer = new Uint8Array(0);
      this.ws = new WebSocket(url, 'mqtt');
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = () => {
        // Con id fijo va sin "clean session" (0 en vez de 2): el broker conserva la suscripción y guarda lo que llegue mientras tanto.
        this.enviar(paquete(0x10, cadena('MQTT'), Uint8Array.from([4, idFijo ? 0 : 2, 0, 60]), cadena(idFijo || 'md' + alfanumerico(16))));
      };
      this.ws.onmessage = (e) => this.recibir(new Uint8Array(e.data));
      this.ws.onclose = () => this.marcarCerrado();
      this.ws.onerror = () => this.marcarCerrado();
    }

    marcarCerrado() {
      this.listo = false;
      this.cerrado = true;
      clearInterval(this.latido);
    }

    enviar(bytes) {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes);
    }

    publicar(tema, carga) {
      this.enviar(paquete(0x30, cadena(tema), texto.encode(carga)));
    }

    // DISCONNECT antes de cerrar: así el broker sabe ya que el teléfono se fue y empieza a guardar, en vez de mandarle a un socket que se va a congelar.
    cerrar() {
      this.enviar(Uint8Array.from([0xE0, 0]));
      this.marcarCerrado();
      try { this.ws.close(); } catch (e) { /* ya estaba */ }
    }

    // Un marco de WebSocket no es un paquete de MQTT: pueden venir partidos o varios juntos.
    recibir(bytes) {
      const junto = new Uint8Array(this.buffer.length + bytes.length);
      junto.set(this.buffer);
      junto.set(bytes, this.buffer.length);
      let posicion = 0;
      while (posicion < junto.length) {
        let i = posicion + 1;
        let largo = 0;
        let factor = 1;
        let completo = false;
        while (i < junto.length && i <= posicion + 4) {
          largo += (junto[i] & 127) * factor;
          factor *= 128;
          if (!(junto[i++] & 128)) { completo = true; break; }
        }
        if (!completo || i + largo > junto.length) break;
        this.atender(junto[posicion], junto.subarray(i, i + largo));
        posicion = i + largo;
      }
      this.buffer = junto.slice(posicion);
    }

    atender(primero, cuerpo) {
      const tipo = primero >> 4;
      if (tipo === 2) {               // CONNACK
        if (cuerpo[1] !== 0) { this.cerrar(); return; }
        this.enviar(paquete(0x82, Uint8Array.from([0, 1]), cadena(this.temaSalida), Uint8Array.from([0])));
        this.latido = setInterval(() => this.enviar(Uint8Array.from([0xC0, 0])), LATIDO_MS);
      } else if (tipo === 9) {        // SUBACK
        this.listo = cuerpo[2] !== 0x80;
      } else if (tipo === 3) {        // PUBLISH
        const largoTema = (cuerpo[0] << 8) | cuerpo[1];
        const qos = (primero >> 1) & 3;
        this.alMensaje(cuerpo.subarray(2 + largoTema + (qos ? 2 : 0)));
      }
    }
  }

  // ---------------------------------------------------------------- sesión
  let sesion = null;

  async function abrir() {
    const guardada = await operarLlave('readonly', (almacen) => almacen.get(CLAVE_LLAVE));
    if (!guardada) {
      escribir(MARCA_INSTALADA, '');     // el sistema la borró: mejor pedir instalarla que callar
      throw new Error('Este teléfono ya no tiene la llave.');
    }
    cerrar();
    sesion = { llave: guardada.llave, tema: guardada.tema, id: idDelTelefono(), brokers: new Map(), pendientes: new Map(), huerfanos: new Map(),
               vistos: new Set(), dormida: false };
  }

  function cerrar() {
    if (!sesion) return;
    sesion.brokers.forEach((b) => b.cerrar());
    sesion.pendientes.forEach((p) => { clearTimeout(p.reloj); p.fallar(new Error('Charlene no responde')); });
    sesion = null;
  }

  // El reloj de cada espera se detiene mientras la app duerme: congelada, al despertar vencería de golpe antes de que llegue lo que EMQX guardó.
  function armar(pendiente, ms) {
    clearTimeout(pendiente.reloj);
    pendiente.espera = ms;
    if (sesion && !sesion.dormida) pendiente.reloj = setTimeout(pendiente.vencer, ms);
  }

  // Al salir de la app: se desconecta limpio y lo pedido sigue pendiente. Lo que la Pi conteste mientras tanto lo guarda EMQX.
  function dormir() {
    if (!sesion || sesion.dormida) return;
    sesion.dormida = true;
    sesion.brokers.forEach((b) => b.cerrar());
    sesion.brokers.clear();
    sesion.pendientes.forEach((p) => clearTimeout(p.reloj));
    sesion.huerfanos.forEach((p) => clearTimeout(p.reloj));
  }

  async function despertar() {
    const propia = sesion;
    if (!propia || !propia.dormida) return;
    propia.dormida = false;
    propia.pendientes.forEach((p) => armar(p, p.espera || ESPERA_RESPUESTA_MS));
    propia.huerfanos.forEach((p) => armar(p, p.espera || ESPERA_CHARLA_MS));
    if (propia.pendientes.size) await conectarBrokers(propia);
  }

  // Conectarse solo para recibir lo que EMQX guardó (respuestas a algo pedido antes de que el sistema cerrara la app).
  async function escuchar() {
    const propia = sesion;
    if (!propia) return;
    if (propia.dormida) await despertar();
    await conectarBrokers(propia);
  }

  // Lo que llega sin nadie esperándolo es la respuesta a algo que se pidió antes de que el sistema cerrara la app del todo: EMQX la guardó. Se arma
  // igual que una esperada y se le entrega a la app, que sabe a qué chat pertenece (o la ignora: también llega lo pedido desde otra pantalla).
  let alResponderTarde = null;
  function huerfano(propia, n) {
    if (!propia.huerfanos.has(n)) {
      propia.huerfanos.set(n, {
        cumplir: (mensaje) => { if (alResponderTarde) alResponderTarde(mensaje); },
        vencer: () => propia.huerfanos.delete(n),
      });
    }
    return propia.huerfanos.get(n);
  }

  async function alRecibir(propia, carga) {
    if (propia !== sesion) return;
    let mensaje;
    try {
      const sobre = JSON.parse(new TextDecoder().decode(carga));
      const claro = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: deB64(sobre.iv) }, propia.llave, deB64(sobre.ct));
      mensaje = JSON.parse(new TextDecoder().decode(claro));
    } catch (e) {
      return;     // el tema es público: lo que no abre con la llave no es de la Pi
    }
    if (typeof mensaje.n !== 'string') return;
    const pendiente = propia.pendientes.get(mensaje.n) || huerfano(propia, mensaje.n);
    // Llega por los dos brokers. "k" numera cada parcial (14 nov 2026): sin él, todo parcial después del primero se
    // descartaba como repetido, y un dibujo viaja en varios trozos.
    const marca = `${mensaje.n}|${!!mensaje.fin}|${mensaje.k ?? ''}`;
    if (propia.vistos.has(marca)) return;
    propia.vistos.add(marca);
    clearTimeout(pendiente.reloj);
    if (typeof mensaje.img === 'string') {   // un trozo de un dibujo de la Xbox: se junta, no se muestra
      (pendiente.trozos = pendiente.trozos || [])[mensaje.parte] = mensaje.img;
      armar(pendiente, ESPERA_CHARLA_MS);
      return;
    }
    if (mensaje.fin) {
      propia.pendientes.delete(mensaje.n);
      propia.huerfanos.delete(mensaje.n);
      if (mensaje.img_partes) {
        // La Pi manda los trozos antes que el final por la misma conexión: si falta alguno, se perdió en el camino.
        const trozos = pendiente.trozos || [];
        let completo = true;
        for (let i = 0; i < mensaje.img_partes; i++) if (typeof trozos[i] !== 'string') completo = false;
        if (completo) mensaje.imagen = `data:${mensaje.img_tipo || 'image/png'};base64,${trozos.join('')}`;
        else mensaje.imagenIncompleta = true;
      }
      pendiente.cumplir(mensaje);
    } else {
      armar(pendiente, ESPERA_CHARLA_MS);
      if (pendiente.alParcial) pendiente.alParcial(mensaje);
    }
  }

  async function conectarBrokers(propia) {
    // Cada chat le habla a la Pi con su propio id (la Pi recuerda la charla por id): se escuchan todos con un comodín.
    const salida = `${propia.tema}/out/+`;
    for (const { url, guarda } of BROKERS) {
      const actual = propia.brokers.get(url);
      if (!actual || actual.cerrado) propia.brokers.set(url, new Broker(url, salida, (carga) => alRecibir(propia, carga), guarda ? 'md' + propia.id : null));
    }
    const listos = () => [...propia.brokers.values()].filter((b) => b.listo);
    const limite = Date.now() + ESPERA_PRIMER_BROKER_MS;
    while (!listos().length && Date.now() < limite) await pausa(100);
    if (!listos().length) return [];
    // Suscrito antes de pedir, y en los dos si el segundo no tarda: uno de los dos solo ya alcanza.
    const limiteSegundo = Date.now() + ESPERA_SEGUNDO_BROKER_MS;
    while (listos().length < BROKERS.length && Date.now() < limiteSegundo) await pausa(100);
    return listos();
  }

  async function pedir(accion, opciones = {}) {
    const propia = sesion;
    if (!propia) throw new Error('Charlene no responde');
    if (propia.dormida) await despertar();
    const brokers = await conectarBrokers(propia);
    if (propia !== sesion || !brokers.length) throw new Error('Charlene no responde');
    const destino = /^[A-Za-z0-9]{8,64}$/.test(opciones.chat || '') ? opciones.chat : propia.id;
    const n = alfanumerico(16);
    const peticion = { n, ts: Math.floor(Date.now() / 1000), accion };
    if (opciones.texto) peticion.texto = opciones.texto;
    if (opciones.modelo) peticion.modelo = opciones.modelo;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, propia.llave, texto.encode(JSON.stringify(peticion)));
    const carga = JSON.stringify({ v: 1, iv: aB64(iv), ct: aB64(ct) });
    return new Promise((cumplir, fallar) => {
      const vencer = () => {
        propia.pendientes.delete(n);
        fallar(new Error('Charlene no responde'));
      };
      const pendiente = { cumplir, fallar, vencer, alParcial: opciones.alParcial };
      propia.pendientes.set(n, pendiente);
      armar(pendiente, accion === 'xllama' ? ESPERA_CHARLA_MS : ESPERA_RESPUESTA_MS);
      if (opciones.alEnviar) opciones.alEnviar(n);      // la app lo guarda en el chat: si la cierran, la respuesta tardía sabe a dónde ir
      brokers.forEach((b) => b.publicar(`${propia.tema}/in/${destino}`, carga));
    });
  }

  escribir(SOBRE_CON_PIN, '');

  window.MiniDoof = {
    instalada, instalar, abrir, abierta: () => !!sesion, pedir, cerrar, temaDe, dormir, despertar, escuchar, chats,
    alResponderTarde: (funcion) => { alResponderTarde = funcion; },
  };
})();
