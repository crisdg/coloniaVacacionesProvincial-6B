// Pruebas aisladas con PostgreSQL real y las rutas actuales, sin consumidor RabbitMQ.
// La base temporal y los triggers de instrumentación se eliminan al finalizar.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { before, after, test } from 'node:test';
import express from 'express';
import pg from 'pg';
import { crearConsultaPadron } from '../src/modules/inscripciones/padron-cliente.js';
import { crearPadronSimulado } from '../src/modules/inscripciones/padron-simulado.js';

const conexion = {
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
};
const baseTemporal = `test_equidad_${process.pid}_${Date.now()}`;
let admin, pool, servidor, baseURL, asignarTurno, creada = false;

before(async () => {
  admin = new pg.Client({ ...conexion, database: process.env.DB_NAME });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${baseTemporal}"`);
  creada = true;
  process.env.DB_NAME = baseTemporal;
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.migrar();
  ({ asignarTurno } = await import('../src/modules/inscripciones/asignacion.js'));
  const { default: inscripciones } = await import('../src/modules/inscripciones/routes.js');
  const { identidad } = await import('../src/shared/identidad.js');
  const { ErrorHttp, problem } = await import('../src/shared/problem.js');
  const app = express();
  app.use(express.json());
  app.use('/inscripciones', identidad, inscripciones);
  app.use((error, req, res, next) => {
    problem(req, res, error instanceof ErrorHttp ? error.status : 500,
      error.title ?? 'Error interno', error.message);
  });
  servidor = app.listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  baseURL = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  if (servidor) await new Promise((resolve, reject) => servidor.close(error => error ? reject(error) : resolve()));
  if (pool) await pool.end();
  if (creada) {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [baseTemporal]);
    await admin.query(`DROP DATABASE "${baseTemporal}"`);
  }
  if (admin) await admin.end();
});

async function esperar(condicion, mensaje) {
  const limite = Date.now() + 1500;
  do {
    const resultado = await condicion();
    if (resultado) return resultado;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < limite);
  assert.fail(mensaje);
}

async function crearTurno() {
  const { rows } = await pool.query(`INSERT INTO colonia.turnos
    (convocatoria_id, sede_id, nombre, fecha_inicio, fecha_fin,
     inscripcion_abre_en, inscripcion_cierra_en, cupo_total)
    VALUES ('verano-2027', 1, 'Prueba de equidad', CURRENT_DATE + 10, CURRENT_DATE + 30,
            clock_timestamp() - interval '1 day', clock_timestamp() + interval '1 day', 1)
    RETURNING id`);
  return rows[0].id;
}

async function solicitar(turnoId, documento, tutor = 'tutor-equidad', { clave, chico = {} } = {}) {
  const nacimiento = new Date();
  nacimiento.setUTCFullYear(nacimiento.getUTCFullYear() - 8);
  const respuesta = await fetch(`${baseURL}/inscripciones`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Usuario-Id': tutor, 'X-Usuario-Roles': 'tutor',
      ...(clave !== undefined && { 'Idempotency-Key': clave }) },
    body: JSON.stringify({ turnoId, chico: {
      documento, nombre: 'Ana', apellido: 'Prueba', fechaNacimiento: nacimiento.toISOString().slice(0, 10), ...chico,
    } }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: respuesta.status, location: respuesta.headers.get('location'), body: await respuesta.json() };
}

test('una admisión pausada antes de ser visible conserva prioridad y no bloquea otros turnos', async () => {
  const turno = await crearTurno();
  const otroTurno = await crearTurno();
  const puerta = new pg.Client({ ...conexion, database: baseTemporal });
  await puerta.connect();
  const solicitudes = [];
  let asignacion;
  try {
    // DEFAULT nextval ya fue evaluado al entrar al trigger, pero la fila aún no es visible.
    // Residencia favorable precargada: esta prueba aísla admisión/asignación del padrón.
    await pool.query(`CREATE FUNCTION colonia.pausar_admision() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.es_residente := true;
        IF NEW.tutor_id = 'admision-pausada' THEN PERFORM pg_advisory_xact_lock(792001); END IF;
        RETURN NEW;
      END $$`);
    await pool.query(`CREATE TRIGGER pausar_admision BEFORE INSERT ON colonia.inscripciones
      FOR EACH ROW EXECUTE FUNCTION colonia.pausar_admision()`);
    await puerta.query('SELECT pg_advisory_lock(792001)');
    const primera = solicitar(turno, '91000001', 'admision-pausada');
    solicitudes.push(primera);
    const pidPrimera = await esperar(async () => {
      const { rows } = await pool.query(`SELECT pid FROM pg_locks
        WHERE locktype = 'advisory' AND objid = 792001 AND NOT granted`);
      return rows[0]?.pid;
    }, 'La primera solicitud no alcanzó la pausa del INSERT.');

    let segundaTerminada = false;
    const segunda = solicitar(turno, '91000002').finally(() => { segundaTerminada = true; });
    solicitudes.push(segunda);
    await esperar(async () => {
      const { rows } = await pool.query('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pidPrimera]);
      return segundaTerminada || rows.length > 0;
    }, 'La segunda solicitud no intentó ingresar.');

    // En la versión defectuosa B ya puede confirmarse; con el bloqueo, espera a A.
    if (segundaTerminada) await asignarTurno(turno);
    else {
      asignacion = asignarTurno(turno);
      asignacion.catch(() => {});
      await esperar(async () => {
        // El asignador puede esperar detrás de B (tuple lock), no directamente de A.
        const { rows } = await pool.query(`SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event <> 'advisory'`);
        return rows.length >= 2;
      }, 'El asignador no esperó a que finalizara la admisión.');
    }
    const independiente = await solicitar(otroTurno, '91000003');
    assert.equal(independiente.status, 202);
    await asignarTurno(otroTurno);
    const otroEstado = await pool.query('SELECT estado FROM colonia.inscripciones WHERE id = $1', [independiente.body.id]);
    assert.equal(otroEstado.rows[0].estado, 'confirmada');

    await puerta.query('SELECT pg_advisory_unlock(792001)');
    const [a, b] = await Promise.all([primera, segunda]);
    if (asignacion) await asignacion;
    assert.equal(a.status, 202, JSON.stringify(a.body));
    assert.equal(b.status, 202, JSON.stringify(b.body));
    assert.ok(a.body.ordenRecepcion < b.body.ordenRecepcion);
    await asignarTurno(turno);
    const { rows } = await pool.query(`SELECT estado FROM colonia.inscripciones
      WHERE turno_id = $1 ORDER BY orden_recepcion`, [turno]);
    assert.deepEqual(rows.map(fila => fila.estado), ['confirmada', 'en_lista_de_espera']);
    const salida = await pool.query(`SELECT count(*)::int AS n FROM colonia.salida
      WHERE inscripcion_id = ANY($1::int[])`, [[a.body.id, b.body.id]]);
    assert.equal(salida.rows[0].n, 2);
  } finally {
    await puerta.query('SELECT pg_advisory_unlock_all()');
    await Promise.allSettled([...solicitudes, ...(asignacion ? [asignacion] : [])]);
    await pool.query('DROP TRIGGER IF EXISTS pausar_admision ON colonia.inscripciones');
    await pool.query('DROP FUNCTION IF EXISTS colonia.pausar_admision()');
    await puerta.end();
  }
});

test('la admisión comprueba el período vigente después de esperar el bloqueo del turno', async () => {
  const turno = await crearTurno();
  const editor = new pg.Client({ ...conexion, database: baseTemporal });
  await editor.connect();
  let solicitud;
  try {
    await editor.query('BEGIN');
    await editor.query('SELECT id FROM colonia.turnos WHERE id = $1 FOR UPDATE', [turno]);
    await editor.query(`UPDATE colonia.turnos SET inscripcion_cierra_en = clock_timestamp() - interval '1 hour'
      WHERE id = $1`, [turno]);
    const { rows: [{ pid }] } = await editor.query('SELECT pg_backend_pid() AS pid');
    solicitud = solicitar(turno, '91000004');
    await esperar(async () => {
      const { rows } = await pool.query('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid]);
      return rows.length > 0;
    }, 'La solicitud no esperó al cambio concurrente del turno.');
    await editor.query('COMMIT');
    const respuesta = await solicitud;
    assert.equal(respuesta.status, 409, JSON.stringify(respuesta.body));
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM colonia.inscripciones WHERE turno_id = $1`, [turno]);
    assert.equal(rows[0].n, 0);
  } finally {
    await editor.query('ROLLBACK');
    if (solicitud) await Promise.allSettled([solicitud]);
    await editor.end();
  }
});

test('reintentos concurrentes conservan respuesta, orden y un único mensaje de salida', async () => {
  const turno = await crearTurno();
  const respuestas = await Promise.all(Array.from({ length: 5 }, () => (
    solicitar(turno, '92000001', 'tutor-idempotente', { clave: 'concurrente-1' })
  )));
  for (const respuesta of respuestas) {
    assert.equal(respuesta.status, 202, JSON.stringify(respuesta.body));
    assert.deepEqual(respuesta, respuestas[0]);
  }
  const { rows } = await pool.query(`SELECT
    (SELECT count(*)::int FROM colonia.inscripciones WHERE turno_id = $1) AS inscripciones,
    (SELECT count(*)::int FROM colonia.salida WHERE inscripcion_id = $2) AS mensajes,
    (SELECT count(*)::int FROM colonia.solicitudes_idempotentes WHERE tutor_id = $3) AS claves`,
  [turno, respuestas[0].body.id, 'tutor-idempotente']);
  assert.deepEqual(rows[0], { inscripciones: 1, mensajes: 1, claves: 1 });
});

test('la misma clave con otros datos o turno da 409; los datos normalizados equivalentes se reutilizan', async () => {
  const turno = await crearTurno();
  const otroTurno = await crearTurno();
  const original = await solicitar(turno, '92000002', 'tutor-conflicto', { clave: 'misma-clave' });
  assert.equal(original.status, 202);
  const equivalente = await solicitar(turno, '92000002', 'tutor-conflicto', {
    clave: 'misma-clave', chico: { nombre: ' Ana ' },
  });
  assert.deepEqual(equivalente, original);
  const cambiado = await solicitar(turno, '92000002', 'tutor-conflicto', {
    clave: 'misma-clave', chico: { nombre: 'Otro nombre' },
  });
  assert.equal(cambiado.status, 409);
  const otro = await solicitar(otroTurno, '92000002', 'tutor-conflicto', { clave: 'misma-clave' });
  assert.equal(otro.status, 409);
});

test('la misma clave concurrente en turnos distintos admite una sola solicitud', async () => {
  const primero = await crearTurno();
  const segundo = await crearTurno();
  const respuestas = await Promise.all([
    solicitar(primero, '92000008', 'tutor-dos-turnos', { clave: 'unica' }),
    solicitar(segundo, '92000009', 'tutor-dos-turnos', { clave: 'unica' }),
  ]);
  assert.deepEqual(respuestas.map(r => r.status).sort(), [202, 409]);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM colonia.inscripciones
    WHERE tutor_id = 'tutor-dos-turnos'`);
  assert.equal(rows[0].n, 1);
});

test('la clave pertenece al tutor y no permite eludir la unicidad del DNI', async () => {
  const turno = await crearTurno();
  const original = await solicitar(turno, '92000003', 'tutor-uno', { clave: 'compartida' });
  assert.equal(original.status, 202);
  const ajena = await solicitar(turno, '92000003', 'tutor-dos', { clave: 'compartida' });
  assert.equal(ajena.status, 409);
  assert.equal((await solicitar(turno, '92000003', 'tutor-uno', { clave: 'otra' })).status, 409);
  assert.equal((await solicitar(turno, '92000003', 'tutor-uno')).status, 409);
  const propia = await solicitar(turno, '92000004', 'tutor-dos', { clave: 'compartida' });
  assert.equal(propia.status, 202);
  assert.notEqual(propia.body.id, original.body.id);
});

test('el reintento devuelve la aceptación original aunque se cancele o cierre el período; GET muestra el estado actual', async () => {
  const turno = await crearTurno();
  const original = await solicitar(turno, '92000005', 'tutor-replay', { clave: 'estable' });
  assert.equal(original.status, 202);
  await pool.query(`UPDATE colonia.inscripciones SET estado = 'cancelada', motivo_cancelacion = 'Prueba'
    WHERE id = $1`, [original.body.id]);
  await pool.query(`UPDATE colonia.turnos SET inscripcion_cierra_en = clock_timestamp() - interval '1 hour' WHERE id = $1`, [turno]);
  assert.deepEqual(await solicitar(turno, '92000005', 'tutor-replay', { clave: 'estable' }), original);
  const actual = await fetch(`${baseURL}/inscripciones/${original.body.id}`, {
    headers: { 'X-Usuario-Id': 'tutor-replay', 'X-Usuario-Roles': 'tutor' },
  });
  assert.equal((await actual.json()).estado, 'cancelada');
  await pool.query(`UPDATE colonia.turnos SET inscripcion_cierra_en = clock_timestamp() + interval '1 day' WHERE id = $1`, [turno]);
  const nueva = await solicitar(turno, '92000005', 'tutor-replay', { clave: 'nueva-solicitud' });
  assert.equal(nueva.status, 202);
  assert.ok(nueva.body.ordenRecepcion > original.body.ordenRecepcion);
});

test('una falla al guardar el outbox revierte inscripción y clave, y permite reintentar', async () => {
  const turno = await crearTurno();
  await pool.query(`CREATE FUNCTION colonia.fallar_salida() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Falla controlada del outbox'; END $$`);
  await pool.query(`CREATE TRIGGER fallar_salida BEFORE INSERT ON colonia.salida
    FOR EACH ROW EXECUTE FUNCTION colonia.fallar_salida()`);
  try {
    const fallida = await solicitar(turno, '92000006', 'tutor-rollback', { clave: 'recuperable' });
    assert.equal(fallida.status, 500);
    const { rows } = await pool.query(`SELECT
      (SELECT count(*)::int FROM colonia.inscripciones WHERE turno_id = $1) AS inscripciones,
      (SELECT count(*)::int FROM colonia.solicitudes_idempotentes WHERE tutor_id = 'tutor-rollback') AS claves`, [turno]);
    assert.deepEqual(rows[0], { inscripciones: 0, claves: 0 });
  } finally {
    await pool.query('DROP TRIGGER fallar_salida ON colonia.salida');
    await pool.query('DROP FUNCTION colonia.fallar_salida()');
  }
  assert.equal((await solicitar(turno, '92000006', 'tutor-rollback', { clave: 'recuperable' })).status, 202);
});

test('claves vacías, inválidas o demasiado largas devuelven 400 sin crear una inscripción', async () => {
  const turno = await crearTurno();
  for (const clave of ['', 'con espacios', 'a'.repeat(129)]) {
    assert.equal((await solicitar(turno, '92000007', 'tutor-validacion', { clave })).status, 400);
  }
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM colonia.inscripciones WHERE turno_id = $1', [turno]);
  assert.equal(rows[0].n, 0);
});

test('las fallas del padrón conservan inscripción y orden, y permiten resolver en otro intento', async () => {
  const { resolverInscripcion } = await import('../src/modules/inscripciones/cola.js');
  const { reservarConsulta } = await import('../src/modules/inscripciones/padron-limite.js');
  for (const [indice, codigo] of ['NO_DISPONIBLE', 'SATURADO'].entries()) {
    const turno = await crearTurno();
    const alta = await solicitar(turno, `9300000${indice + 1}`);
    assert.equal(alta.status, 202);
    let permisos = 0;
    const consultar = crearConsultaPadron({
      reservarConsulta: async () => {
        const espera = await reservarConsulta();
        if (espera === 0) permisos++;
        return espera;
      },
      consultarResidencia: crearPadronSimulado({ escenarios: [{ error: codigo }] }),
    });
    await assert.rejects(resolverInscripcion(alta.body.id, consultar), { codigo });
    const pendiente = await pool.query(`SELECT estado, es_residente, orden_recepcion, motivo_rechazo
      FROM colonia.inscripciones WHERE id = $1`, [alta.body.id]);
    assert.deepEqual(pendiente.rows[0], {
      estado: 'pendiente_de_validacion', es_residente: null,
      orden_recepcion: String(alta.body.ordenRecepcion), motivo_rechazo: null,
    });
    await resolverInscripcion(alta.body.id, consultar);
    const resuelta = await pool.query('SELECT estado, orden_recepcion FROM colonia.inscripciones WHERE id = $1', [alta.body.id]);
    assert.deepEqual(resuelta.rows[0], { estado: 'confirmada', orden_recepcion: String(alta.body.ordenRecepcion) });
    // Puede haber permisos descartados por vigencia, pero nunca menos de uno por intento.
    assert.ok(permisos >= 2);
  }
});

test('una respuesta lenta del adaptador no permite adelantar a otra inscripción', async () => {
  const { resolverInscripcion } = await import('../src/modules/inscripciones/cola.js');
  const { reservarConsulta } = await import('../src/modules/inscripciones/padron-limite.js');
  const turno = await crearTurno();
  const primera = await solicitar(turno, '93000003');
  const segunda = await solicitar(turno, '93000004');
  assert.equal(primera.status, 202);
  assert.equal(segunda.status, 202);
  let liberar, avisar;
  const pausa = new Promise(resolve => { liberar = resolve; });
  const inicio = new Promise(resolve => { avisar = resolve; });
  const consultar = crearConsultaPadron({
    reservarConsulta,
    consultarResidencia: crearPadronSimulado({
      escenarios: [{ demoraMs: 500 }],
      esperar: () => { avisar(); return pausa; },
    }),
  });
  const lenta = resolverInscripcion(primera.body.id, consultar);
  try {
    await Promise.race([inicio, lenta.then(() => assert.fail('La primera consulta no esperó.'))]);
    await resolverInscripcion(segunda.body.id, consultar);
    const { rows } = await pool.query(`SELECT estado, es_residente FROM colonia.inscripciones
      WHERE turno_id = $1 ORDER BY orden_recepcion`, [turno]);
    assert.deepEqual(rows, [
      { estado: 'pendiente_de_validacion', es_residente: null },
      { estado: 'pendiente_de_validacion', es_residente: true },
    ]);
  } finally {
    liberar();
    await lenta;
  }
  const { rows } = await pool.query('SELECT estado FROM colonia.inscripciones WHERE turno_id = $1 ORDER BY orden_recepcion', [turno]);
  assert.deepEqual(rows.map(fila => fila.estado), ['confirmada', 'en_lista_de_espera']);
});
