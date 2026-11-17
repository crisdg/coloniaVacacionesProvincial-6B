import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { before, after, beforeEach, test } from 'node:test';
import pg from 'pg';

const conexion = {
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
};
const baseTemporal = `test_ventana_${process.pid}_${Date.now()}`;
let admin, pool, reservarConsulta, creada = false;

before(async () => {
  admin = new pg.Client({ ...conexion, database: process.env.DB_NAME });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${baseTemporal}"`);
  creada = true;
  process.env.DB_NAME = baseTemporal;
  process.env.PADRON_CONSULTAS_POR_SEGUNDO = '50';
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.migrar();
  ({ reservarConsulta } = await import('../src/modules/inscripciones/padron-limite.js'));
});

after(async () => {
  if (pool) await pool.end();
  if (creada) {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [baseTemporal]);
    await admin.query(`DROP DATABASE "${baseTemporal}"`);
  }
  if (admin) await admin.end();
});

beforeEach(async () => { await pool.query('TRUNCATE colonia.permisos_padron'); });

async function crearProceso(t) {
  const hijo = fork(new URL('./helpers/padron-worker.mjs', import.meta.url), [], { silent: true });
  let errores = '';
  hijo.stderr.on('data', datos => { errores += datos; });
  t.after(async () => {
    if (hijo.exitCode === null && hijo.signalCode === null) {
      const fin = once(hijo, 'exit');
      hijo.kill();
      await fin;
    }
  });
  async function recibir() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => terminar(new Error('El proceso no respondió.')), 15000);
      const salir = () => terminar(new Error(`Terminó sin responder: ${errores}`));
      const mensaje = datos => terminar(null, datos);
      function terminar(error, datos) {
        clearTimeout(timeout);
        hijo.off('exit', salir);
        hijo.off('message', mensaje);
        hijo.off('error', terminar);
        if (error) reject(error); else resolve(datos);
      }
      hijo.once('exit', salir);
      hijo.once('error', terminar);
      hijo.once('message', mensaje);
    });
  }
  assert.deepEqual(await recibir(), { listo: true });
  return async (consultas = 0) => {
    const respuesta = recibir();
    hijo.send({ consultas });
    const resultado = await respuesta;
    assert.equal(resultado.error, undefined);
    return resultado;
  };
}

test('no se renueva el cupo al cruzar el cambio de segundo', async () => {
  // Simular 50 permisos en el último milisegundo del segundo y consultar justo
  // después del corte. La espera se alinea con el reloj de PostgreSQL, no el host.
  const { rows: [{ corte }] } = await pool.query(`
    WITH reloj AS (SELECT date_trunc('second', clock_timestamp()) + interval '1 second' AS corte)
    INSERT INTO colonia.permisos_padron (concedido_en)
    SELECT corte - interval '1 millisecond' FROM reloj, generate_series(1, 50)
    RETURNING concedido_en + interval '1 millisecond' AS corte`);
  await pool.query(`SELECT pg_sleep(greatest(0, extract(epoch FROM
    ($1::timestamptz + interval '10 milliseconds' - clock_timestamp()))))`, [corte]);
  const espera = await reservarConsulta();
  assert.ok(espera > 0 && espera <= 1100, `No debe renovar 50 permisos: espera=${espera}`);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM colonia.permisos_padron');
  assert.equal(rows[0].n, 50);
});

test('limpia permisos vencidos y admite una nueva consulta', async () => {
  await pool.query(`INSERT INTO colonia.permisos_padron (concedido_en)
    SELECT clock_timestamp() - interval '2 seconds' FROM generate_series(1, 50)`);
  assert.equal(await reservarConsulta(), 0);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM colonia.permisos_padron');
  assert.equal(rows[0].n, 1);
});

test('las reservas concurrentes comparten el mismo cupo', async () => {
  const respuestas = await Promise.all(Array.from({ length: 55 }, () => reservarConsulta()));
  assert.equal(respuestas.filter(espera => espera === 0).length, 50);
  assert.equal(respuestas.filter(espera => espera > 0).length, 5);
});

test('un proceso nuevo conserva el límite ya ocupado en PostgreSQL', async (t) => {
  const ejecutar = await crearProceso(t);
  await pool.query(`INSERT INTO colonia.permisos_padron (concedido_en)
    SELECT clock_timestamp() FROM generate_series(1, 50)`);
  const resultado = await ejecutar();
  assert.ok(resultado.espera > 0);
});

test('tres procesos no superan 50 inicios reales del adaptador en ninguna ventana de un segundo', async (t) => {
  const procesos = await Promise.all(Array.from({ length: 3 }, () => crearProceso(t)));
  const resultados = await Promise.all(procesos.map(ejecutar => ejecutar(20)));
  const instantes = resultados.flatMap(r => r.instantes.map(BigInt)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  assert.equal(instantes.length, 60);
  for (let i = 50; i < instantes.length; i++) {
    assert.ok(instantes[i] - instantes[i - 50] >= 1_000_000_000n,
      'Se observaron 51 inicios de consulta en menos de un segundo.');
  }
});
