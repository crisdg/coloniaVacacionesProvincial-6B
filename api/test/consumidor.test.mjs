// Base temporal, procesos independientes y reentregas de un RabbitMQ real.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { before, beforeEach, after, test } from 'node:test';
import pg from 'pg';
import amqp from 'amqplib';

const baseTemporal = `test_consumidor_${process.pid}_${Date.now()}`;
let admin, pool, poolConsumidor, resolverInscripcion, consumir, creada = false;

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
  ({ poolConsumidor, resolverInscripcion } = await import('../src/modules/inscripciones/consumidor.js'));
  ({ consumir } = await import('../src/modules/inscripciones/cola.js'));
});

beforeEach(async () => {
  await pool.query('DELETE FROM colonia.salida');
  await pool.query('DELETE FROM colonia.inscripciones');
  await pool.query('DELETE FROM colonia.turnos');
});

after(async () => {
  if (poolConsumidor) await poolConsumidor.end();
  if (pool) await pool.end();
  if (creada) {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [baseTemporal]);
    await admin.query(`DROP DATABASE "${baseTemporal}"`);
  }
  if (admin) await admin.end();
});

async function sembrar(cantidad = 1, cupo = 1) {
  const { rows: [turno] } = await pool.query(`INSERT INTO colonia.turnos
    (convocatoria_id, sede_id, nombre, fecha_inicio, fecha_fin,
     inscripcion_abre_en, inscripcion_cierra_en, cupo_total)
    VALUES ('verano-2027', 1, 'Prueba consumidor', CURRENT_DATE + 10, CURRENT_DATE + 30,
            now() - interval '1 day', now() + interval '1 day', $1) RETURNING id`, [cupo]);
  const { rows } = await pool.query(`INSERT INTO colonia.inscripciones
    (turno_id, convocatoria_id, tutor_id, documento, nombre, apellido, fecha_nacimiento)
    SELECT $1, 'verano-2027', 'tutor-consumidor', (95000000 + n)::text, 'Ana', 'Prueba',
           CURRENT_DATE - interval '8 years' FROM generate_series(1, $2::integer) AS n RETURNING id`,
  [turno.id, cantidad]);
  return rows.map(fila => fila.id).sort((a, b) => a - b);
}

async function estado() {
  return (await pool.query(`SELECT id, estado, es_residente, orden_recepcion, padron_consultado_en,
    xmin::text AS version FROM colonia.inscripciones ORDER BY orden_recepcion`)).rows;
}

async function iniciarReplica(t, id) {
  const hijo = fork(new URL('./helpers/consumidor-worker.mjs', import.meta.url), [String(id)], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const salida = once(hijo, 'exit');
  t.after(async () => {
    if (hijo.exitCode === null && hijo.signalCode === null) hijo.kill('SIGKILL');
    await salida;
  });
  const [mensaje] = await once(hijo, 'message', { signal: AbortSignal.timeout(5000) });
  assert.deepEqual(mensaje, { consultando: true });
  return { hijo, salida };
}

test('dos procesos no consultan la misma inscripción y otra inscripción puede avanzar', { timeout: 15000 }, async t => {
  const [primera, segunda] = await sembrar(2);
  const { hijo, salida } = await iniciarReplica(t, primera);
  assert.equal(await resolverInscripcion(primera, () => assert.fail('Consulta duplicada')), false);
  assert.equal(await resolverInscripcion(segunda, async () => true), true);
  const antes = await estado();
  assert.deepEqual(antes.map(fila => fila.es_residente), [null, true]);
  assert.deepEqual(antes.map(fila => fila.estado), ['pendiente_de_validacion', 'pendiente_de_validacion']);
  // Ya validada, pero esperando a la anterior: una reentrega tampoco la reprocesa.
  assert.equal(await resolverInscripcion(segunda, () => assert.fail('Residencia ya conocida')), true);
  assert.deepEqual(await estado(), antes);
  const terminado = once(hijo, 'message', { signal: AbortSignal.timeout(5000) });
  hijo.send({ continuar: true });
  assert.deepEqual((await terminado)[0], { resuelta: true });
  await salida;
  const despues = await estado();
  assert.deepEqual(despues.map(fila => fila.estado), ['confirmada', 'en_lista_de_espera']);
  await resolverInscripcion(primera, () => assert.fail('Confirmada no consulta'));
  await resolverInscripcion(segunda, () => assert.fail('Lista de espera no consulta'));
  assert.deepEqual(await estado(), despues, 'No se repiten escrituras ni asignación.');
});

test('canceladas, rechazadas e inexistentes se reconocen sin consultar ni modificar', async () => {
  const [cancelada, rechazada] = await sembrar(2);
  await pool.query("UPDATE colonia.inscripciones SET estado = 'cancelada' WHERE id = $1", [cancelada]);
  await pool.query("UPDATE colonia.inscripciones SET estado = 'rechazada', es_residente = false WHERE id = $1", [rechazada]);
  const antes = await estado();
  for (const id of [cancelada, rechazada, 2147483647]) {
    assert.equal(await resolverInscripcion(id, () => assert.fail('No debe consultar')), true);
  }
  assert.deepEqual(await estado(), antes);
});

test('una falla del padrón libera la inscripción para otro intento', async () => {
  const [id] = await sembrar();
  const antes = await estado();
  await assert.rejects(resolverInscripcion(id, async () => { throw new Error('Padrón caído'); }), /Padrón caído/);
  const despues = await estado();
  assert.deepEqual(despues.map(({ version, ...fila }) => fila), antes.map(({ version, ...fila }) => fila));
  assert.equal(await resolverInscripcion(id, () => assert.fail('Todavía no vence la espera')), false);
  await vencerEspera(id);
  assert.equal(await resolverInscripcion(id, async () => true), true);
  assert.equal((await estado())[0].estado, 'confirmada');
});

test('si falla la asignación no se guarda un resultado parcial y la reentrega puede recuperarlo', async () => {
  const [id] = await sembrar();
  let consultas = 0;
  const consultar = async () => { consultas++; return true; };
  await pool.query(`CREATE FUNCTION colonia.fallar_asignacion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Asignación fallida'; END $$`);
  await pool.query(`CREATE TRIGGER fallar_asignacion BEFORE UPDATE OF estado ON colonia.inscripciones
    FOR EACH ROW EXECUTE FUNCTION colonia.fallar_asignacion()`);
  try {
    await assert.rejects(resolverInscripcion(id, consultar), /Asignación fallida/);
    const [pendiente] = await estado();
    assert.equal(pendiente.estado, 'pendiente_de_validacion');
    assert.equal(pendiente.es_residente, null);
    assert.equal(pendiente.padron_consultado_en, null);
  } finally {
    await pool.query('DROP TRIGGER fallar_asignacion ON colonia.inscripciones');
    await pool.query('DROP FUNCTION colonia.fallar_asignacion()');
  }
  await vencerEspera(id);
  assert.equal(await resolverInscripcion(id, consultar), true);
  assert.equal(consultas, 2, 'Sin commit se puede repetir la consulta externa.');
  assert.equal((await estado())[0].estado, 'confirmada');
});

test('al morir el consumidor otra réplica retoma la inscripción', { timeout: 15000 }, async t => {
  const [id] = await sembrar();
  const { hijo, salida } = await iniciarReplica(t, id);
  hijo.kill('SIGKILL');
  await salida;
  assert.equal(await resolverInscripcion(id, () => assert.fail('Reclamación vigente')), false);
  await pool.query("UPDATE colonia.inscripciones SET padron_proximo_intento_en = clock_timestamp() - interval '1 second', padron_reclamado_hasta = clock_timestamp() - interval '1 second' WHERE id = $1", [id]);
  const limite = Date.now() + 2000;
  let resuelta;
  do {
    resuelta = await resolverInscripcion(id, async () => true);
    if (resuelta) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < limite);
  assert.equal(resuelta, true);
  assert.equal((await estado())[0].estado, 'confirmada');
});

test('una reclamación vencida puede recuperarse y el dueño viejo no sobrescribe al sucesor', async () => {
  const [id] = await sembrar();
  const inicio = Promise.withResolvers();
  const continuar = Promise.withResolvers();
  const anterior = resolverInscripcion(id, async () => { inicio.resolve(); await continuar.promise; return true; });
  try {
    await inicio.promise;
    await pool.query("UPDATE colonia.inscripciones SET padron_proximo_intento_en = clock_timestamp() - interval '1 second', padron_reclamado_hasta = clock_timestamp() - interval '1 second' WHERE id = $1", [id]);
    assert.equal(await resolverInscripcion(id, async () => false), true);
  } finally {
    continuar.resolve();
    assert.equal(await anterior, false);
  }
  const [fila] = await estado();
  assert.equal(fila.estado, 'rechazada');
  assert.equal(fila.es_residente, false);
});

test('un resultado vencido se descarta aunque todavía no haya sucesor', async () => {
  const [id] = await sembrar();
  assert.equal(await resolverInscripcion(id, async () => {
    await pool.query("UPDATE colonia.inscripciones SET padron_proximo_intento_en = clock_timestamp() - interval '1 second', padron_reclamado_hasta = clock_timestamp() - interval '1 second' WHERE id = $1", [id]);
    return true;
  }), false);
  assert.equal((await estado())[0].es_residente, null);
  assert.equal(await resolverInscripcion(id, async () => true), true);
});

for (const volver of [false, true]) {
  test('una corrección invalida el resultado en vuelo, incluso volviendo al documento original: ' + volver, async () => {
    const [id] = await sembrar();
    assert.equal(await resolverInscripcion(id, async documento => {
      await pool.query("UPDATE colonia.inscripciones SET documento = '96000001' WHERE id = $1", [id]);
      if (volver) await pool.query('UPDATE colonia.inscripciones SET documento = $2 WHERE id = $1', [id, documento]);
      return true;
    }), false);
    assert.equal((await estado())[0].es_residente, null);
    assert.equal(await resolverInscripcion(id, async () => false), true);
    assert.equal((await estado())[0].estado, 'rechazada');
  });
}

test('cambiar el documento invalida una residencia ya guardada que esperaba orden', async () => {
  const [, id] = await sembrar(2);
  await resolverInscripcion(id, async () => true);
  await pool.query("UPDATE colonia.inscripciones SET documento = '96000001' WHERE id = $1", [id]);
  let consultas = 0;
  await resolverInscripcion(id, async documento => { consultas++; assert.equal(documento, '96000001'); return false; });
  assert.equal(consultas, 1);
  assert.equal((await estado())[1].es_residente, false);
});

test('una cancelación durante la consulta no queda bloqueada ni se revierte por una respuesta tardía', async () => {
  const [id] = await sembrar();
  await resolverInscripcion(id, async () => {
    await pool.query("UPDATE colonia.inscripciones SET estado = 'cancelada' WHERE id = $1", [id]);
    return true;
  });
  const [fila] = await estado();
  assert.equal(fila.estado, 'cancelada');
  assert.equal(fila.es_residente, null);
});

test('esperar al padrón no retiene conexiones ni impide obtener permisos globales', { timeout: 15000 }, async () => {
  const ids = await sembrar(10, 10);
  const { consultarPadron } = await import('../src/modules/inscripciones/padron.js');
  const todos = Promise.withResolvers();
  const continuar = Promise.withResolvers();
  let iniciados = 0;
  const trabajos = ids.map(id => resolverInscripcion(id, async (...args) => {
    if (++iniciados === ids.length) todos.resolve();
    await continuar.promise;
    return consultarPadron(...args);
  }));
  try {
    await todos.promise;
    assert.equal(poolConsumidor.idleCount, poolConsumidor.totalCount);
    await pool.query('SELECT 1');
  } finally {
    continuar.resolve();
    assert.deepEqual(await Promise.all(trabajos), Array(10).fill(true));
  }
  assert.ok((await estado()).every(fila => fila.es_residente !== null));
});

test('RabbitMQ reentrega después de commit sin ACK y el consumidor no vuelve a procesar', { timeout: 15000 }, async () => {
  const [id] = await sembrar();
  const conexion = await amqp.connect({
    hostname: process.env.COLA_HOST, port: Number(process.env.COLA_PORT || 5672),
    username: process.env.COLA_USER, password: process.env.COLA_PASSWORD,
    vhost: process.env.COLA_VHOST || '/',
  });
  try {
    const canal = await conexion.createConfirmChannel();
    const { queue } = await canal.assertQueue('', { exclusive: true });
    await new Promise((resolve, reject) => canal.sendToQueue(queue, Buffer.from(JSON.stringify({ inscripcionId: id })),
      { persistent: true }, error => error ? reject(error) : resolve()));
    const primera = await canal.get(queue, { noAck: false });
    let consultas = 0;
    const resolver = id => resolverInscripcion(id, async () => { consultas++; return true; });
    let ackIntentado = false;
    await consumir(canal, primera, { resolver, confirmar: (_canal, _msg, metodo) => {
      assert.equal(metodo, 'ack');
      ackIntentado = true; // Se pierde el ACK, luego se cierra el canal.
    } });
    assert.equal(ackIntentado, true);
    const antes = await estado();
    await canal.close();
    const siguiente = await conexion.createChannel();
    const reentrega = await siguiente.get(queue, { noAck: false });
    assert.ok(reentrega.fields.redelivered);
    await consumir(siguiente, reentrega, { resolver, confirmar: (ch, msg, metodo) => {
      assert.equal(metodo, 'ack');
      ch.ack(msg);
    } });
    assert.equal(consultas, 1);
    assert.deepEqual(await estado(), antes);
    assert.equal(await siguiente.get(queue, { noAck: true }), false);
  } finally {
    await conexion.close();
  }
});

test('una entrega en vuelo o fallida recibe NACK; una resuelta recibe ACK', async () => {
  const msg = { content: Buffer.from('{"inscripcionId":1}') };
  for (const resultado of [false, new Error('Fallo temporal'), true]) {
    const confirmaciones = [];
    await consumir({}, msg, {
      resolver: async () => { if (resultado instanceof Error) throw resultado; return resultado; },
      confirmar: (_canal, _msg, metodo) => confirmaciones.push(metodo),
    });
    assert.deepEqual(confirmaciones, [resultado === true ? 'ack' : 'nack']);
  }
});

test('una consulta larga renueva su reclamación sin habilitar duplicados', { timeout: 30000 }, async () => {
  const [id] = await sembrar();
  const inicio = Promise.withResolvers();
  const continuar = Promise.withResolvers();
  const trabajo = resolverInscripcion(id, async () => { inicio.resolve(); await continuar.promise; return true; });
  try {
    await inicio.promise;
    const { rows: [antes] } = await pool.query('SELECT padron_reclamado_hasta FROM colonia.inscripciones WHERE id = $1', [id]);
    await new Promise(resolve => setTimeout(resolve, 21000));
    const { rows: [despues] } = await pool.query('SELECT padron_reclamado_hasta FROM colonia.inscripciones WHERE id = $1', [id]);
    assert.ok(despues.padron_reclamado_hasta > antes.padron_reclamado_hasta);
    assert.equal(await resolverInscripcion(id, () => assert.fail('Consulta duplicada')), false);
  } finally {
    continuar.resolve();
    await trabajo;
  }
});

async function vencerEspera(id) {
  await pool.query("UPDATE colonia.inscripciones SET padron_proximo_intento_en = clock_timestamp() - interval '1 second' WHERE id = $1", [id]);
}

test('saturación guarda espera durable; otro proceso recupera sin adelantar el turno', { timeout: 15000 }, async t => {
  const [primera, segunda] = await sembrar(2);
  const orden = (await estado()).map(fila => fila.orden_recepcion);
  const error = Object.assign(new Error('Saturado'), { codigo: 'SATURADO', reintentarEnMs: 90000 });
  await assert.rejects(resolverInscripcion(primera, async () => { throw error; }), { codigo: 'SATURADO' });
  const { rows: [registro] } = await pool.query(`SELECT padron_intentos, padron_ultimo_error,
    extract(epoch FROM (padron_proximo_intento_en - padron_ultimo_intento_en)) AS demora
    FROM colonia.inscripciones WHERE id = $1`, [primera]);
  assert.equal(registro.padron_intentos, 1);
  assert.equal(registro.padron_ultimo_error, 'SATURADO');
  assert.ok(Number(registro.demora) >= 90);
  assert.equal(await resolverInscripcion(primera, () => assert.fail('No ignorar Retry-After')), false);
  await resolverInscripcion(segunda, async () => true);
  assert.deepEqual((await estado()).map(fila => fila.estado), ['pendiente_de_validacion', 'pendiente_de_validacion']);
  await vencerEspera(primera);
  const { hijo, salida } = await iniciarReplica(t, primera);
  const terminado = once(hijo, 'message', { signal: AbortSignal.timeout(5000) });
  hijo.send({ continuar: true });
  assert.deepEqual((await terminado)[0], { resuelta: true });
  await salida;
  assert.deepEqual((await estado()).map(fila => fila.estado), ['confirmada', 'en_lista_de_espera']);
  assert.deepEqual((await estado()).map(fila => fila.orden_recepcion), orden);
  const { rows: [final] } = await pool.query('SELECT padron_intentos, padron_proximo_intento_en, padron_ultimo_error FROM colonia.inscripciones WHERE id = $1', [primera]);
  assert.deepEqual(final, { padron_intentos: 2, padron_proximo_intento_en: null, padron_ultimo_error: null });
});

test('timeout deja pendiente, programa reintento y una respuesta tardía no modifica el resultado', async () => {
  const [id] = await sembrar();
  const tardia = Promise.withResolvers();
  let signal;
  await assert.rejects(resolverInscripcion(id, (_documento, _jurisdiccion, opciones) => {
    signal = opciones.signal;
    return tardia.promise;
  }, { timeoutMs: 20 }), { codigo: 'TIMEOUT' });
  assert.equal(signal.aborted, true);
  assert.equal((await estado())[0].estado, 'pendiente_de_validacion');
  const { rows: [intento] } = await pool.query('SELECT padron_ultimo_error, padron_intentos FROM colonia.inscripciones WHERE id = $1', [id]);
  assert.deepEqual(intento, { padron_ultimo_error: 'TIMEOUT', padron_intentos: 1 });
  assert.equal(await resolverInscripcion(id, () => assert.fail('Esperar backoff')), false);
  await vencerEspera(id);
  await resolverInscripcion(id, async () => false);
  const antes = await estado();
  tardia.resolve(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await estado(), antes);
  assert.equal(antes[0].estado, 'rechazada');
});

test('fallas repetidas aumentan la demora durable y los duplicados no cuentan como intentos', async () => {
  const [id] = await sembrar();
  for (let numero = 1; numero <= 3; numero++) {
    await assert.rejects(resolverInscripcion(id, async () => { throw new Error('Caído'); }), /Caído/);
    const { rows: [fila] } = await pool.query(`SELECT padron_intentos,
      extract(epoch FROM (padron_proximo_intento_en - padron_ultimo_intento_en)) AS demora
      FROM colonia.inscripciones WHERE id = $1`, [id]);
    assert.equal(fila.padron_intentos, numero);
    assert.ok(Number(fila.demora) >= 2 ** (numero - 1));
    assert.equal(await resolverInscripcion(id, () => assert.fail('Duplicado anticipado')), false);
    await vencerEspera(id);
  }
});

test('una falla al guardar el reintento no produce ACK y conserva la planificación inicial', async () => {
  const [id] = await sembrar();
  await pool.query(`CREATE FUNCTION colonia.fallar_reintento() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Escritura fallida'; END $$`);
  await pool.query(`CREATE TRIGGER fallar_reintento BEFORE UPDATE OF padron_ultimo_error ON colonia.inscripciones
    FOR EACH ROW EXECUTE FUNCTION colonia.fallar_reintento()`);
  try {
    const confirmaciones = [];
    await consumir({}, { content: Buffer.from(JSON.stringify({ inscripcionId: id })) }, {
      resolver: id => resolverInscripcion(id, async () => { throw new Error('Caído'); }),
      confirmar: (_canal, _msg, metodo) => confirmaciones.push(metodo),
    });
    assert.deepEqual(confirmaciones, ['nack']);
    const { rows: [fila] } = await pool.query('SELECT padron_intentos, padron_proximo_intento_en, estado FROM colonia.inscripciones WHERE id = $1', [id]);
    assert.equal(fila.padron_intentos, 1);
    assert.ok(fila.padron_proximo_intento_en);
    assert.equal(fila.estado, 'pendiente_de_validacion');
  } finally {
    await pool.query('DROP TRIGGER fallar_reintento ON colonia.inscripciones');
    await pool.query('DROP FUNCTION colonia.fallar_reintento()');
  }
  await vencerEspera(id);
  assert.equal(await resolverInscripcion(id, async () => true), true);
});

test('RabbitMQ conserva la falla durable y reentrega tras cerrar el canal hasta obtener ACK', { timeout: 15000 }, async () => {
  const [id] = await sembrar();
  const conexion = await amqp.connect({
    hostname: process.env.COLA_HOST, port: Number(process.env.COLA_PORT || 5672),
    username: process.env.COLA_USER, password: process.env.COLA_PASSWORD,
    vhost: process.env.COLA_VHOST || '/',
  });
  try {
    const canal = await conexion.createConfirmChannel();
    const { queue } = await canal.assertQueue('', { exclusive: true });
    canal.sendToQueue(queue, Buffer.from(JSON.stringify({ inscripcionId: id })), { persistent: true });
    await canal.waitForConfirms();
    const entrega = await canal.get(queue, { noAck: false });
    await consumir(canal, entrega, {
      resolver: id => resolverInscripcion(id, async () => { throw new Error('Padrón caído'); }),
      confirmar: (_ch, _msg, metodo) => assert.equal(metodo, 'nack'),
    });
    const { rows: [falla] } = await pool.query('SELECT padron_intentos, padron_proximo_intento_en FROM colonia.inscripciones WHERE id = $1', [id]);
    assert.equal(falla.padron_intentos, 1);
    assert.ok(falla.padron_proximo_intento_en);
    // Simula caída antes de enviar NACK: el broker conserva la entrega sin ACK.
    await canal.close();
    await vencerEspera(id);
    const nuevo = await conexion.createChannel();
    const repetida = await nuevo.get(queue, { noAck: false });
    assert.ok(repetida.fields.redelivered);
    let durable = false;
    await consumir(nuevo, repetida, {
      resolver: async id => {
        const resultado = await resolverInscripcion(id, async () => true);
        durable = (await estado())[0].estado === 'confirmada';
        return resultado;
      },
      confirmar: (ch, msg, metodo) => { assert.equal(metodo, 'ack'); assert.equal(durable, true); ch.ack(msg); },
    });
    assert.equal(await nuevo.get(queue, { noAck: true }), false);
  } finally {
    await conexion.close();
  }
});
