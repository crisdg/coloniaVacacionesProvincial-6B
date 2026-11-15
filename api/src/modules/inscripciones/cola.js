import amqp from 'amqplib';
import { pool, enTransaccion } from '../../db.js';
import { asignarTurno } from './asignacion.js';
import { consultarPadron } from './padron.js';

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
    const { rows } = await pool.query(
      'SELECT id, inscripcion_id FROM colonia.salida WHERE publicado_en IS NULL ORDER BY id LIMIT 20',
    );
    for (const fila of rows) {
      if (canalActual !== canal) return;
      await publicar(canal, fila.inscripcion_id);
      await pool.query(
        'UPDATE colonia.salida SET publicado_en = clock_timestamp() WHERE id = $1 AND publicado_en IS NULL',
        [fila.id],
      );
    }
  } catch (error) {
    console.error('No se pudo publicar en la cola:', error.message);
  } finally {
    publicando = false;
  }
}

// La consulta al padrón ocurre fuera de la transacción: el tope puede hacer esperar
// y no conviene retener el lock del turno mientras tanto.
async function resolverInscripcion(inscripcionId) {
  const { rows } = await pool.query(
    `SELECT i.id, i.turno_id, i.documento, i.estado, i.es_residente, c.jurisdiccion
     FROM colonia.inscripciones i
     JOIN colonia.convocatorias c ON c.id = i.convocatoria_id
     WHERE i.id = $1`,
    [inscripcionId],
  );
  const previa = rows[0];
  if (!previa) return;
  let residente;
  let documentoConsultado;
  if (previa.estado === 'pendiente_de_validacion' && previa.es_residente === null) {
    residente = await consultarPadron(previa.documento, previa.jurisdiccion);
    documentoConsultado = previa.documento;
  }
  await enTransaccion(async (client) => {
    await client.query('SELECT id FROM colonia.turnos WHERE id = $1 FOR UPDATE', [previa.turno_id]);
    const actual = await client.query(
      'SELECT id, estado, documento, es_residente FROM colonia.inscripciones WHERE id = $1 FOR UPDATE',
      [inscripcionId],
    );
    const fila = actual.rows[0];
    if (!fila || fila.estado === 'cancelada' || fila.estado === 'rechazada') return;
    if (fila.estado === 'pendiente_de_validacion' && fila.es_residente === null
      && fila.documento === documentoConsultado && residente !== undefined) {
      await client.query(
        `UPDATE colonia.inscripciones SET es_residente = $2, padron_consultado_en = clock_timestamp() WHERE id = $1`,
        [fila.id, residente],
      );
    }
    await asignarTurno(previa.turno_id, client);
  });
}

function consumir(canal, msg) {
  if (!msg) return;
  let datos;
  try {
    datos = JSON.parse(msg.content.toString());
  } catch (error) {
    console.error('Mensaje de la cola ilegible; se descarta:', error.message);
    acusar(canal, msg, 'ack');
    return;
  }
  if (!Number.isInteger(datos.inscripcionId)) {
    console.error('Mensaje de la cola sin inscripcionId; se descarta.');
    acusar(canal, msg, 'ack');
    return;
  }
  resolverInscripcion(datos.inscripcionId)
    .then(() => acusar(canal, msg, 'ack'))
    .catch((error) => {
      console.error(`La inscripción ${datos.inscripcionId} sigue pendiente; se reintenta: ${error.message}`);
      setTimeout(() => acusar(canal, msg, 'nack'), 1000);
    });
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
