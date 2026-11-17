// PostgreSQL y RabbitMQ reales, con base temporal y cola exclusiva de prueba.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { before, beforeEach, after, test } from 'node:test';
import pg from 'pg';
import amqp from 'amqplib';

const baseTemporal = `test_outbox_${process.pid}_${Date.now()}`;
let admin, pool, publicarLoteSalida, creada = false;

before(async () => {
  admin = new pg.Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${baseTemporal}"`);
  creada = true;
  process.env.DB_NAME = baseTemporal;
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.migrar();
  ({ publicarLoteSalida } = await import('../src/modules/inscripciones/outbox.js'));
});

beforeEach(async () => {
  await pool.query('DELETE FROM colonia.salida');
  await pool.query('DELETE FROM colonia.inscripciones');
  await pool.query('DELETE FROM colonia.turnos');
});

after(async () => {
  if (pool) await pool.end();
  if (creada) {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [baseTemporal]);
    await admin.query(`DROP DATABASE "${baseTemporal}"`);
  }
  if (admin) await admin.end();
});

async function sembrar(cantidad) {
  const { rows: [turno] } = await pool.query(`INSERT INTO colonia.turnos
    (convocatoria_id, sede_id, nombre, fecha_inicio, fecha_fin,
     inscripcion_abre_en, inscripcion_cierra_en, cupo_total)
    VALUES ('verano-2027', 1, 'Prueba outbox', CURRENT_DATE + 10, CURRENT_DATE + 30,
            now() - interval '1 day', now() + interval '1 day', 100) RETURNING id`);
  const { rows } = await pool.query(`INSERT INTO colonia.inscripciones
    (turno_id, convocatoria_id, tutor_id, documento, nombre, apellido, fecha_nacimiento)
    SELECT $1, 'verano-2027', 'tutor-outbox', (94000000 + n)::text, 'Ana', 'Prueba',
           CURRENT_DATE - interval '8 years' FROM generate_series(1, $2::integer) AS n RETURNING id`,
  [turno.id, cantidad]);
  const ids = rows.map(fila => fila.id).sort((a, b) => a - b);
  await pool.query('INSERT INTO colonia.salida (inscripcion_id) SELECT unnest($1::integer[])', [ids]);
  return ids;
}

async function pendientes() {
  const { rows } = await pool.query(
    'SELECT inscripcion_id FROM colonia.salida WHERE publicado_en IS NULL ORDER BY id',
  );
  return rows.map(fila => fila.inscripcion_id);
}

test('otro publicador omite la fila en vuelo y no duplica sus mensajes', { timeout: 10000 }, async () => {
  const ids = await sembrar(6);
  const reclamada = Promise.withResolvers();
  const confirmar = Promise.withResolvers();
  const enviados = [];
  const primero = publicarLoteSalida(async id => {
    enviados.push(id);
    reclamada.resolve();
    await confirmar.promise;
  }, { maximo: 1 });
  try {
    await reclamada.promise;
    assert.deepEqual(await pendientes(), ids, 'No se marca antes del confirm.');
    const cantidad = await publicarLoteSalida(async id => { enviados.push(id); });
    assert.equal(cantidad, 5);
    assert.deepEqual(await pendientes(), [ids[0]], 'La fila bloqueada sigue pendiente.');
  } finally {
    confirmar.resolve();
    await primero;
  }
  assert.deepEqual(enviados.sort((a, b) => a - b), ids);
  assert.deepEqual(await pendientes(), []);
  assert.equal(await publicarLoteSalida(() => assert.fail('No debe republicar')), 0);
});

test('una falla del broker conserva el mensaje pendiente sin revertir los anteriores', async () => {
  const ids = await sembrar(3);
  await assert.rejects(publicarLoteSalida(async id => {
    if (id === ids[1]) throw new Error('Confirm fallido');
  }), /Confirm fallido/);
  assert.deepEqual(await pendientes(), ids.slice(1));
  const reintentados = [];
  assert.equal(await publicarLoteSalida(async id => { reintentados.push(id); }), 2);
  assert.deepEqual(reintentados, ids.slice(1));
  assert.deepEqual(await pendientes(), []);
});

test('una falla al marcar después del confirm permite reentrega sin perder el mensaje', async () => {
  const [id] = await sembrar(1);
  const enviados = [];
  await pool.query(`CREATE FUNCTION colonia.fallar_marca() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Marca fallida'; END $$`);
  await pool.query(`CREATE TRIGGER fallar_marca BEFORE UPDATE ON colonia.salida
    FOR EACH ROW EXECUTE FUNCTION colonia.fallar_marca()`);
  try {
    await assert.rejects(publicarLoteSalida(async id => { enviados.push(id); }), /Marca fallida/);
    assert.deepEqual(await pendientes(), [id]);
  } finally {
    await pool.query('DROP TRIGGER fallar_marca ON colonia.salida');
    await pool.query('DROP FUNCTION colonia.fallar_marca()');
  }
  await publicarLoteSalida(async id => { enviados.push(id); });
  assert.deepEqual(enviados, [id, id], 'La garantía sigue siendo al menos una vez.');
  assert.deepEqual(await pendientes(), []);
});

test('al morir una réplica se libera su fila y otra puede publicarla', { timeout: 10000 }, async t => {
  const [id] = await sembrar(1);
  const hijo = fork(new URL('./helpers/outbox-worker.mjs', import.meta.url), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const salida = once(hijo, 'exit');
  t.after(async () => {
    if (hijo.exitCode === null && hijo.signalCode === null) hijo.kill('SIGKILL');
    await salida;
  });
  const [mensaje] = await once(hijo, 'message', { signal: AbortSignal.timeout(5000) });
  assert.deepEqual(mensaje, { reclamada: id });
  assert.equal(await publicarLoteSalida(() => assert.fail('La fila pertenece a la otra réplica')), 0);
  hijo.kill('SIGKILL');
  await salida;
  const enviados = [];
  const limite = Date.now() + 2000;
  do {
    await publicarLoteSalida(async id => { enviados.push(id); });
    if (enviados.length) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < limite);
  assert.deepEqual(enviados, [id]);
  assert.deepEqual(await pendientes(), []);
});

test('dos publicadores con confirms reales entregan cada evento una vez sin fallas', { timeout: 10000 }, async () => {
  const ids = await sembrar(30);
  const conexion = await amqp.connect({
    hostname: process.env.COLA_HOST, port: Number(process.env.COLA_PORT || 5672),
    username: process.env.COLA_USER, password: process.env.COLA_PASSWORD,
    vhost: process.env.COLA_VHOST || '/',
  });
  try {
    const canales = await Promise.all([conexion.createConfirmChannel(), conexion.createConfirmChannel()]);
    const { queue } = await canales[0].assertQueue('', { exclusive: true });
    const totales = await Promise.all(canales.map(canal => publicarLoteSalida(id => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Confirm vencido')), 5000);
      canal.sendToQueue(queue, Buffer.from(JSON.stringify({ inscripcionId: id })), { persistent: true }, error => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    }))));
    assert.equal(totales.reduce((a, b) => a + b, 0), ids.length);
    const recibidos = [];
    for (let i = 0; i < ids.length; i++) {
      const mensaje = await canales[0].get(queue, { noAck: true });
      assert.ok(mensaje);
      recibidos.push(JSON.parse(mensaje.content).inscripcionId);
    }
    assert.deepEqual(recibidos.sort((a, b) => a - b), ids);
    assert.equal(await canales[0].get(queue, { noAck: true }), false);
    assert.deepEqual(await pendientes(), []);
  } finally {
    await conexion.close();
  }
});
