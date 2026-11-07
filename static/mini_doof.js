/* Charlene: hablarle a la Raspberry directo desde el teléfono, para cuando la PC está apagada y no hay puente ni túnel.

   Va por MQTT sobre WebSocket a dos brokers públicos: quien sea puede leer el tema, así que lo único que protege es el sobre AES-GCM. MQTT escrito a mano
   (lo poco que hace falta: conectar, suscribir, publicar sin QoS) porque la CSP de la app no carga scripts de fuera, y una librería entera sería más código que confiar.

   La llave la entrega el puente una vez, con huella, y queda en IndexedDB como CryptoKey no extraíble: se puede usar, pero ni este código puede volver a leerla. Sin PIN
   a propósito (decisión de Javier, 6 nov 2026): se abre en una emergencia. Lo que la protege es el bloqueo del teléfono, y encender pide confirmar en la interfaz. */
(() => {
  'use strict';

  const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
  const BASE_DE_DATOS = 'mini_doof';
  const ALMACEN = 'llave';
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
      const pedido = indexedDB.open(BASE_DE_DATOS, 1);
      pedido.onupgradeneeded = () => pedido.result.createObjectStore(ALMACEN);
      pedido.onsuccess = () => listo(pedido.result);
      pedido.onerror = () => fallar(pedido.error);
    });
  }

  async function operarLlave(modo, operar) {
    const base = await abrirBase();
    try {
      return await new Promise((listo, fallar) => {
        const transaccion = base.transaction(ALMACEN, modo);
        const pedido = operar(transaccion.objectStore(ALMACEN));
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
    constructor(url, temaSalida, alMensaje) {
      this.listo = false;
      this.cerrado = false;
      this.temaSalida = temaSalida;
      this.alMensaje = alMensaje;
      this.buffer = new Uint8Array(0);
      this.ws = new WebSocket(url, 'mqtt');
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = () => {
        this.enviar(paquete(0x10, cadena('MQTT'), Uint8Array.from([4, 2, 0, 60]), cadena('md' + alfanumerico(16))));
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

    cerrar() {
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
    sesion = { llave: guardada.llave, tema: guardada.tema, id: idDelTelefono(), brokers: new Map(), pendientes: new Map(), vistos: new Set() };
  }

  function cerrar() {
    if (!sesion) return;
    sesion.brokers.forEach((b) => b.cerrar());
    sesion.pendientes.forEach((p) => { clearTimeout(p.reloj); p.fallar(new Error('Charlene no responde')); });
    sesion = null;
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
    const pendiente = propia.pendientes.get(mensaje.n);
    if (!pendiente) return;
    const marca = `${mensaje.n}|${!!mensaje.fin}`;   // llega por los dos brokers
    if (propia.vistos.has(marca)) return;
    propia.vistos.add(marca);
    clearTimeout(pendiente.reloj);
    if (mensaje.fin) {
      propia.pendientes.delete(mensaje.n);
      pendiente.cumplir(mensaje);
    } else {
      pendiente.reloj = setTimeout(pendiente.vencer, ESPERA_CHARLA_MS);
      if (pendiente.alParcial) pendiente.alParcial(mensaje);
    }
  }

  async function conectarBrokers(propia) {
    const salida = `${propia.tema}/out/${propia.id}`;
    for (const url of BROKERS) {
      const actual = propia.brokers.get(url);
      if (!actual || actual.cerrado) propia.brokers.set(url, new Broker(url, salida, (carga) => alRecibir(propia, carga)));
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
    const brokers = await conectarBrokers(propia);
    if (propia !== sesion || !brokers.length) throw new Error('Charlene no responde');
    const n = alfanumerico(16);
    const peticion = { n, ts: Math.floor(Date.now() / 1000), accion };
    if (opciones.texto) peticion.texto = opciones.texto;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, propia.llave, texto.encode(JSON.stringify(peticion)));
    const carga = JSON.stringify({ v: 1, iv: aB64(iv), ct: aB64(ct) });
    return new Promise((cumplir, fallar) => {
      const vencer = () => {
        propia.pendientes.delete(n);
        fallar(new Error('Charlene no responde'));
      };
      propia.pendientes.set(n, { cumplir, fallar, vencer, alParcial: opciones.alParcial, reloj: setTimeout(vencer, ESPERA_RESPUESTA_MS) });
      brokers.forEach((b) => b.publicar(`${propia.tema}/in/${propia.id}`, carga));
    });
  }

  escribir(SOBRE_CON_PIN, '');

  window.MiniDoof = { instalada, instalar, abrir, abierta: () => !!sesion, pedir, cerrar, temaDe };
})();
