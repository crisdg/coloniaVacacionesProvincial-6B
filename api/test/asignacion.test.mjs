import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import pg from 'pg';

const base = `test_asignacion_${process.pid}_${Date.now()}`;
let admin, pool, asignarTurno, creada = false;
before(async () => {
  admin = new pg.Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${base}"`);
  creada = true;
  process.env.DB_NAME = base;
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.migrar();
  ({ asignarTurno } = await import('../src/modules/inscripciones/asignacion.js'));
});
beforeEach(async () => {
  await pool.query('DELETE FROM colonia.inscripciones');
  await pool.query('DELETE FROM colonia.turnos');
});
after(async () => {
  await pool?.end();
  if (creada) await admin.query(`DROP DATABASE "${base}"`);
  await admin?.end();
});
async function sembrar(filas, cupo) {
  const { rows: [turno] } = await pool.query(`INSERT INTO colonia.turnos
    (convocatoria_id, sede_id, nombre, fecha_inicio, fecha_fin, inscripcion_abre_en, inscripcion_cierra_en, cupo_total)
    VALUES ('verano-2027', 1, 'Asignador', CURRENT_DATE + 10, CURRENT_DATE + 30, now(), now() + interval '1 day', $1)
    RETURNING id`, [cupo]);
  await pool.query(`INSERT INTO colonia.inscripciones
    (turno_id, convocatoria_id, tutor_id, documento, nombre, apellido, fecha_nacimiento, estado, es_residente)
    SELECT $1, 'verano-2027', 'tutor', (98000000 + n)::text, 'Ana', 'Prueba', CURRENT_DATE - interval '8 years',
      fila->>0, (fila->>1)::boolean
    FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS datos(fila, n) ORDER BY n`, [turno.id, JSON.stringify(filas)]);
  return turno.id;
}
const leer = async () => (await pool.query('SELECT id, estado, es_residente, motivo_rechazo FROM colonia.inscripciones ORDER BY orden_recepcion')).rows;

// Oráculo: recorrido del asignador anterior, independiente de las consultas nuevas.
function anterior(filas, cupo) {
  const resultado = structuredClone(filas);
  let ocupadas = filas.filter(f => f.estado === 'confirmada').length;
  for (const fila of resultado) {
    if (!['pendiente_de_validacion', 'en_lista_de_espera'].includes(fila.estado)) continue;
    if (fila.estado === 'pendiente_de_validacion') {
      if (fila.es_residente === null) break;
      if (!fila.es_residente) {
        fila.estado = 'rechazada';
        fila.motivo_rechazo = 'El chico no reside en la jurisdicción Provincia.';
        continue;
      }
    }
    if (ocupadas < cupo) {
      fila.estado = 'confirmada';
      fila.motivo_rechazo = null;
      ocupadas++;
    } else if (fila.estado === 'pendiente_de_validacion') fila.estado = 'en_lista_de_espera';
  }
  return resultado;
}

test('mismo resultado que el recorrido anterior con barreras, rechazos, canceladas y distintos cupos', async () => {
  const tipos = [['pendiente_de_validacion', null], ['pendiente_de_validacion', true],
    ['pendiente_de_validacion', false], ['en_lista_de_espera', true], ['confirmada', true], ['cancelada', null]];
  let semilla = 42;
  for (let caso = 0; caso < 24; caso++) {
    await pool.query('DELETE FROM colonia.inscripciones');
    const filas = Array.from({ length: 35 }, () => {
      semilla = (Math.imul(semilla, 1664525) + 1013904223) >>> 0;
      return tipos[semilla % tipos.length];
    });
    const cupo = caso % 12;
    const turno = await sembrar(filas, cupo);
    const esperado = anterior(await leer(), cupo);
    await asignarTurno(turno);
    assert.deepEqual(await leer(), esperado, `Caso ${caso}`);
  }
});

test('cancelación de la barrera y aumento de cupo continúan toda la asignación sin otro mensaje', async () => {
  const turno = await sembrar([['pendiente_de_validacion', null], ['pendiente_de_validacion', false],
    ...Array.from({ length: 600 }, () => ['pendiente_de_validacion', true])], 1);
  await asignarTurno(turno);
  assert.ok((await leer()).every(f => f.estado === 'pendiente_de_validacion'));
  const [primera] = await leer();
  await pool.query("UPDATE colonia.inscripciones SET estado = 'cancelada' WHERE id = $1", [primera.id]);
  await asignarTurno(turno);
  let filas = await leer();
  assert.equal(filas[1].estado, 'rechazada');
  assert.equal(filas[2].estado, 'confirmada');
  assert.equal(filas.filter(f => f.estado === 'en_lista_de_espera').length, 599);
  await pool.query('UPDATE colonia.turnos SET cupo_total = 601 WHERE id = $1', [turno]);
  await asignarTurno(turno);
  filas = await leer();
  assert.equal(filas.filter(f => f.estado === 'confirmada').length, 600);
});

test('una lista de 5000 espera sin locks innecesarios y usa menos buffers que el recorrido anterior', async t => {
  const turno = await sembrar([...Array.from({ length: 5000 }, () => ['en_lista_de_espera', true]),
    ['pendiente_de_validacion', true]], 1);
  await pool.query('ANALYZE colonia.inscripciones');
  const client = await pool.connect();
  const otro = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [viejo] } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT i.id, i.estado, i.es_residente, c.jurisdiccion FROM colonia.inscripciones i
      JOIN colonia.convocatorias c ON c.id = i.convocatoria_id
      WHERE turno_id = $1 AND estado IN ('pendiente_de_validacion', 'en_lista_de_espera')
      ORDER BY orden_recepcion FOR UPDATE OF i`, [turno]);
    const planViejo = viejo['QUERY PLAN'][0].Plan;
    await client.query('ROLLBACK');
    const consultas = [];
    await client.query('BEGIN');
    await asignarTurno(turno, { query: (sql, valores) => { consultas.push([sql, valores]); return client.query(sql, valores); } });
    const filas = await client.query('SELECT id FROM colonia.inscripciones ORDER BY orden_recepcion LIMIT 3');
    await otro.query('BEGIN');
    // La primera obtuvo plaza; las siguientes no deben quedar bloqueadas.
    await otro.query('SELECT id FROM colonia.inscripciones WHERE id = ANY($1::int[]) FOR UPDATE NOWAIT',
      [filas.rows.slice(1).map(f => f.id)]);
    await otro.query('ROLLBACK');
    await client.query('ROLLBACK');
    // Repetir exactamente las consultas capturadas, ahora con medición de buffers.
    await client.query('BEGIN');
    let buffers = 0;
    for (const [sql, valores] of consultas) {
      const { rows: [resultado] } = await client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, valores);
      const plan = resultado['QUERY PLAN'][0].Plan;
      buffers += plan['Shared Hit Blocks'] + plan['Shared Read Blocks'];
    }
    const anteriores = planViejo['Shared Hit Blocks'] + planViejo['Shared Read Blocks'];
    assert.equal(planViejo['Actual Rows'], 5001);
    assert.ok(buffers < anteriores / 2, `${buffers} buffers nuevos frente a ${anteriores} anteriores`);
    t.diagnostic(`Lista de 5001: ${anteriores} buffers en SELECT anterior; ${buffers} en todo el asignador nuevo.`);
    await client.query('ROLLBACK');
  } finally {
    await client.query('ROLLBACK');
    await otro.query('ROLLBACK');
    client.release();
    otro.release();
  }
});
