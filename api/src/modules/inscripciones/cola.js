import amqp from 'amqplib';
import { publicarLoteSalida } from './outbox.js';
import { resolverInscripcion } from './consumidor.js';

export { resolverInscripcion } from './consumidor.js';

const COLA = 'colonia.residencia';

let canalActual = null;
let publicando = false;
let timer = null;
let conectando = false;

export async function registrarSalida(client, inscripcionId) {
  await client.query('INSERT INTO colonia.salida (inscripcion_id) VALUES ($1)', [inscripcionId]);
}

async function publicar(canal, inscripcionId) {
  return new Promise((resolver, rechazar) => {
    const vencimiento = setTimeout(() => rechazar(new Error('La cola no confirmó la publicación.')), 5000);
    try {
      // Exchange por defecto: el routing key es el nombre de la cola. Un mensaje, un consumidor.
      canal.publish('', COLA, Buffer.from(JSON.stringify({ inscripcionId })), { persistent: true, contentType: 'application/json' }, (error) => {
        clearTimeout(vencimiento);
        if (error) rechazar(error);
        else resolver();
      });
    } catch (error) {
      clearTimeout(vencimiento);
      rechazar(error);
    }
  });
}

async function publicarPendientes() {
  const canal = canalActual;
  if (!canal || publicando) return;
  publicando = true;
  try {
    await publicarLoteSalida(async (inscripcionId) => {
      if (canalActual !== canal) throw new Error('El canal cambió antes de publicar.');
      await publicar(canal, inscripcionId);
    });
  } catch (error) {
    console.error('No se pudo publicar en la cola:', error.message);
  } finally {
    publicando = false;
  }
}

export async function consumir(canal, msg, { resolver = resolverInscripcion, confirmar = acusar } = {}) {
  if (!msg) return;
  let datos;
  try {
    datos = JSON.parse(msg.content.toString());
  } catch (error) {
    console.error('Mensaje de la cola ilegible; se descarta:', error.message);
    confirmar(canal, msg, 'ack');
    return;
  }
  if (!Number.isInteger(datos?.inscripcionId) || datos.inscripcionId <= 0 || datos.inscripcionId > 2147483647) {
    console.error('Mensaje de la cola sin inscripcionId; se descarta.');
    confirmar(canal, msg, 'ack');
    return;
  }
  try {
    const resuelta = await resolver(datos.inscripcionId);
    if (resuelta) {
      confirmar(canal, msg, 'ack');
      return;
    }
    // No confirmar un duplicado en vuelo: su dueño todavía puede fallar.
  } catch (error) {
    console.error(`La inscripción ${datos.inscripcionId} sigue pendiente; se reintenta: ${error.message}`);
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
  confirmar(canal, msg, 'nack');
}

function acusar(canal, msg, metodo) {
  if (canalActual !== canal) return;
  try {
    canal[metodo](msg, false, metodo === 'nack');
  } catch (error) {
    console.error('No se pudo confirmar el mensaje de la cola:', error.message);
  }
}

async function conectar() {
  if (conectando || canalActual) return;
  const host = process.env.COLA_HOST;
  const usuario = process.env.COLA_USER;
  const clave = process.env.COLA_PASSWORD;
  if (!host || !usuario || !clave) {
    console.error('Faltan COLA_HOST, COLA_USER o COLA_PASSWORD; la cola se reintenta.');
    setTimeout(conectar, 2000);
    return;
  }
  conectando = true;
  let conexion;
  try {
    conexion = await amqp.connect({
      protocol: 'amqp',
      hostname: host,
      port: Number(process.env.COLA_PORT ?? 5672),
      username: usuario,
      password: clave,
      vhost: process.env.COLA_VHOST ?? '/',
      heartbeat: 30,
    });
    conexion.on('error', (error) => console.error('Error de conexión con la cola:', error.message));
    conexion.on('close', () => {
      if (!canalActual) return;
      canalActual = null;
      console.error('Se cerró la conexión con la cola; se reintenta.');
      setTimeout(conectar, 2000);
    });
    const canal = await conexion.createConfirmChannel();
    canal.on('error', (error) => console.error('Error en el canal de la cola:', error.message));
    await canal.assertQueue(COLA, { durable: true });
    // Varios mensajes a la vez: el tope de 50 por segundo es global, no de este canal.
    await canal.prefetch(20);
    await canal.consume(COLA, (msg) => consumir(canal, msg), { noAck: false });
    canalActual = canal;
    console.log('Cola de residencia conectada.');
    publicarPendientes();
  } catch (error) {
    canalActual = null;
    if (conexion) await conexion.close().catch(() => {});
    console.error('No se pudo conectar a la cola; se reintenta:', error.message);
    setTimeout(conectar, 2000);
  } finally {
    conectando = false;
  }
}

export function iniciarCola() {
  if (!timer) {
    timer = setInterval(() => { publicarPendientes(); }, 250);
    timer.unref?.();
  }
  conectar();
}
