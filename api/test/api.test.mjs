// Pruebas de contrato contra la API en la red de Compose, con la identidad que pondría el gateway.
// docker compose -f docker-compose.yml -f docker-compose.auth.yml run --rm --no-deps -v ./api/test:/app/test api node --test test/api.test.mjs
import assert from 'node:assert/strict';
import pg from 'pg';
import { test } from 'node:test';

const BASE = process.env.API_TEST_URL ?? 'http://api:3000';
const ADMIN = { 'X-Usuario-Id': 'prueba-admin', 'X-Usuario-Roles': 'administrador' };
const TUTOR = { 'X-Usuario-Id': `prueba-tutor-${Date.now()}`, 'X-Usuario-Roles': 'tutor' };
const OTRO_TUTOR = { 'X-Usuario-Id': `prueba-otro-${Date.now()}`, 'X-Usuario-Roles': 'tutor' };

async function llamar(metodo, ruta, { como, cuerpo } = {}) {
  const respuesta = await fetch(BASE + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...como },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  const texto = await respuesta.text();
  return { status: respuesta.status, headers: respuesta.headers, body: texto ? JSON.parse(texto) : undefined };
}

function esProblema(respuesta, status) {
  assert.equal(respuesta.status, status, JSON.stringify(respuesta.body));
  assert.match(respuesta.headers.get('content-type'), /application\/problem\+json/);
  assert.equal(respuesta.body.status, status);
}

const horas = (n) => new Date(Date.now() + n * 3600_000);
const fechaDentroDe = (dias) => horas(dias * 24).toISOString().slice(0, 10);
const dniAlAzar = () => {
  const documento = String(10_000_000 + Math.floor(Math.random() * 89_999_999));
  return documento.endsWith('0') ? `${documento.slice(0, -1)}1` : documento;
};
const dniTerminadoEn = (digito) => `${dniAlAzar().slice(0, -1)}${digito}`;

async function esperarInscripcion(id, como, listo) {
  let ultimo;
  for (let i = 0; i < 80; i += 1) {
    ultimo = await llamar('GET', `/inscripciones/${id}`, { como });
    if (ultimo.status === 200 && listo(ultimo.body)) return ultimo.body;
    await new Promise((resolver) => setTimeout(resolver, 100));
  }
  assert.fail(`La inscripción ${id} no llegó al estado esperado: ${JSON.stringify(ultimo?.body)}`);
}
function nacidoHace(anios) {
  const fecha = new Date();
  fecha.setUTCFullYear(fecha.getUTCFullYear() - anios);
  fecha.setUTCDate(fecha.getUTCDate() - 10);
  return fecha.toISOString().slice(0, 10);
}

const turnoAbierto = () => ({
  convocatoriaId: 'verano-2027',
  sedeId: 1,
  nombre: 'Turno de prueba',
  fechaInicio: fechaDentroDe(10),
  fechaFin: fechaDentroDe(30),
  inscripcionAbreEn: horas(-1).toISOString(),
  inscripcionCierraEn: horas(24).toISOString(),
  cupoTotal: 2,
});

const chico = (extra = {}) => ({ documento: dniAlAzar(), nombre: 'Sofía', apellido: 'Gómez', fechaNacimiento: nacidoHace(8), ...extra });

test('sin identidad del gateway responde 401', async () => {
  esProblema(await llamar('GET', '/turnos'), 401);
});

test('turnos: alta, consulta, actualización y errores', async () => {
  const creado = await llamar('POST', '/turnos', { como: ADMIN, cuerpo: turnoAbierto() });
  assert.equal(creado.status, 201);
  assert.equal(creado.headers.get('location'), `turnos/${creado.body.id}`);
  assert.deepEqual(
    { confirmados: creado.body.confirmados, disponibles: creado.body.disponibles, enEspera: creado.body.enEspera },
    { confirmados: 0, disponibles: 2, enEspera: 0 },
  );

  const listado = await llamar('GET', '/turnos', { como: TUTOR });
  assert.equal(listado.status, 200);
  assert.ok(listado.body.some((turno) => turno.id === creado.body.id));

  const detalle = await llamar('GET', `/turnos/${creado.body.id}`, { como: TUTOR });
  assert.equal(detalle.status, 200);
  assert.equal(detalle.body.fechaInicio, turnoAbierto().fechaInicio);

  const actualizado = await llamar('PATCH', `/turnos/${creado.body.id}`, { como: ADMIN, cuerpo: { cupoTotal: 5 } });
  assert.equal(actualizado.status, 200);
  assert.equal(actualizado.body.cupoTotal, 5);
  assert.equal(actualizado.body.disponibles, 5);

  esProblema(await llamar('PATCH', `/turnos/${creado.body.id}`, { como: ADMIN, cuerpo: {} }), 400);
  esProblema(await llamar('PATCH', `/turnos/${creado.body.id}`, { como: ADMIN, cuerpo: { sedeId: 2 } }), 400);
  esProblema(await llamar('PATCH', `/turnos/${creado.body.id}`, { como: ADMIN, cuerpo: { fechaFin: '2000-01-01' } }), 400);
  esProblema(await llamar('GET', '/turnos/999999999', { como: ADMIN }), 404);
  esProblema(await llamar('GET', '/turnos/abc', { como: ADMIN }), 400);
  esProblema(await llamar('POST', '/turnos', { como: ADMIN, cuerpo: { ...turnoAbierto(), sedeId: 999 } }), 400);
  esProblema(await llamar('POST', '/turnos', { como: ADMIN, cuerpo: { ...turnoAbierto(), extra: true } }), 400);
  esProblema(await llamar('POST', '/turnos', {
    como: ADMIN,
    cuerpo: { ...turnoAbierto(), inscripcionCierraEn: horas(24 * 40).toISOString() },
  }), 400);
});

test('inscripciones: alta, unicidad, titularidad, corrección y cancelación', async () => {
  const turno = (await llamar('POST', '/turnos', { como: ADMIN, cuerpo: turnoAbierto() })).body;
  const datos = chico();

  const alta = await llamar('POST', '/inscripciones', { como: TUTOR, cuerpo: { turnoId: turno.id, chico: datos } });
  assert.equal(alta.status, 202);
  assert.equal(alta.body.estado, 'pendiente_de_validacion');
  assert.equal(alta.headers.get('location'), `inscripciones/${alta.body.id}`);
  assert.ok(Number.isInteger(alta.body.ordenRecepcion));

  esProblema(await llamar('POST', '/inscripciones', { como: OTRO_TUTOR, cuerpo: { turnoId: turno.id, chico: datos } }), 409);
  esProblema(await llamar('POST', '/inscripciones', {
    como: TUTOR, cuerpo: { turnoId: turno.id, chico: chico({ fechaNacimiento: nacidoHace(5) }) },
  }), 400);
  esProblema(await llamar('POST', '/inscripciones', { como: TUTOR, cuerpo: { turnoId: 999999999, chico: chico() } }), 404);
  esProblema(await llamar('POST', '/inscripciones', {
    como: TUTOR, cuerpo: { turnoId: turno.id, chico: chico({ documento: '12.345.678' }) },
  }), 400);

  const propias = await llamar('GET', '/inscripciones', { como: TUTOR });
  assert.deepEqual(propias.body.map((inscripcion) => inscripcion.id), [alta.body.id]);
  const ajenas = await llamar('GET', '/inscripciones', { como: OTRO_TUTOR });
  assert.deepEqual(ajenas.body, []);
  esProblema(await llamar('GET', `/inscripciones/${alta.body.id}`, { como: OTRO_TUTOR }), 404);
  assert.equal((await llamar('GET', `/inscripciones/${alta.body.id}`, { como: ADMIN })).status, 200);

  const confirmada = await esperarInscripcion(alta.body.id, TUTOR, (inscripcion) => inscripcion.estado === 'confirmada');
  assert.equal(confirmada.chico.documento, datos.documento);

  const corregida = await llamar('PATCH', `/inscripciones/${alta.body.id}`, { como: ADMIN, cuerpo: { chico: { apellido: 'Pérez' } } });
  assert.equal(corregida.status, 200);
  assert.equal(corregida.body.chico.apellido, 'Pérez');
  assert.equal(corregida.body.ordenRecepcion, alta.body.ordenRecepcion);
  assert.equal(corregida.body.estado, 'confirmada');
  const otroDocumento = dniAlAzar();
  const conDni = await llamar('PATCH', `/inscripciones/${alta.body.id}`, { como: ADMIN, cuerpo: { chico: { documento: otroDocumento } } });
  assert.equal(conDni.status, 200, JSON.stringify(conDni.body));
  assert.equal(conDni.body.chico.documento, otroDocumento);
  assert.equal(conDni.body.estado, 'confirmada');
  assert.equal(conDni.body.ordenRecepcion, alta.body.ordenRecepcion);
  esProblema(await llamar('PATCH', `/inscripciones/${alta.body.id}`, {
    como: ADMIN, cuerpo: { chico: { documento: dniTerminadoEn('0') } },
  }), 409);
  assert.equal((await llamar('GET', `/inscripciones/${alta.body.id}`, { como: ADMIN })).body.chico.documento, otroDocumento);
  esProblema(await llamar('PATCH', `/inscripciones/${alta.body.id}`, { como: ADMIN, cuerpo: { chico: {} } }), 400);

  esProblema(await llamar('POST', `/inscripciones/${alta.body.id}/cancelaciones`, { como: ADMIN, cuerpo: { motivo: '   ' } }), 400);
  const cancelada = await llamar('POST', `/inscripciones/${alta.body.id}/cancelaciones`, {
    como: ADMIN, cuerpo: { motivo: 'Solicitud de baja del tutor.' },
  });
  assert.equal(cancelada.status, 200);
  assert.equal(cancelada.body.estado, 'cancelada');
  assert.equal(cancelada.body.motivoCancelacion, 'Solicitud de baja del tutor.');
  esProblema(await llamar('POST', `/inscripciones/${alta.body.id}/cancelaciones`, { como: ADMIN, cuerpo: { motivo: 'Otra vez' } }), 409);
  esProblema(await llamar('PATCH', `/inscripciones/${alta.body.id}`, { como: ADMIN, cuerpo: { chico: { nombre: 'Ana' } } }), 409);

  const nueva = await llamar('POST', '/inscripciones', { como: TUTOR, cuerpo: { turnoId: turno.id, chico: datos } });
  assert.equal(nueva.status, 202);
  assert.ok(nueva.body.ordenRecepcion > alta.body.ordenRecepcion);
});

test('inscripción fuera del período responde 409', async () => {
  const cerrado = await llamar('POST', '/turnos', {
    como: ADMIN,
    cuerpo: { ...turnoAbierto(), inscripcionAbreEn: horas(-48).toISOString(), inscripcionCierraEn: horas(-1).toISOString() },
  });
  assert.equal(cerrado.status, 201);
  esProblema(await llamar('POST', '/inscripciones', { como: TUTOR, cuerpo: { turnoId: cerrado.body.id, chico: chico() } }), 409);
});

test('inscripciones concurrentes del mismo DNI: solo una queda activa', async () => {
  const turno = (await llamar('POST', '/turnos', { como: ADMIN, cuerpo: turnoAbierto() })).body;
  const datos = chico();
  const respuestas = await Promise.all(Array.from({ length: 5 }, () => (
    llamar('POST', '/inscripciones', { como: TUTOR, cuerpo: { turnoId: turno.id, chico: datos } })
  )));
  assert.deepEqual(respuestas.map((r) => r.status).sort(), [202, 409, 409, 409, 409]);
});

test('sin residencia queda rechazada y la plaza sigue el orden', async () => {
  const turno = (await llamar('POST', '/turnos', { como: ADMIN, cuerpo: { ...turnoAbierto(), cupoTotal: 1 } })).body;
  const tutor = { 'X-Usuario-Id': `tutor-rechazo-${Date.now()}`, 'X-Usuario-Roles': 'tutor' };
  const fuera = await llamar('POST', '/inscripciones', {
    como: tutor, cuerpo: { turnoId: turno.id, chico: chico({ documento: dniTerminadoEn('0') }) },
  });
  const dentro = await llamar('POST', '/inscripciones', { como: tutor, cuerpo: { turnoId: turno.id, chico: chico() } });
  assert.equal(fuera.status, 202);
  assert.equal(dentro.status, 202);
  const rechazada = await esperarInscripcion(fuera.body.id, tutor, (inscripcion) => inscripcion.estado === 'rechazada');
  assert.equal(rechazada.motivoRechazo, 'El chico no reside en la jurisdicción Provincia.');
  await esperarInscripcion(dentro.body.id, tutor, (inscripcion) => inscripcion.estado === 'confirmada');
  const detalle = await llamar('GET', `/turnos/${turno.id}`, { como: tutor });
  assert.equal(detalle.body.confirmados, 1);
  assert.equal(detalle.body.disponibles, 0);
});

test('aumentar el cupo confirma la lista de espera sin adelantar pendientes', async () => {
  const turno = (await llamar('POST', '/turnos', { como: ADMIN, cuerpo: { ...turnoAbierto(), cupoTotal: 1 } })).body;
  const tutor = { 'X-Usuario-Id': `tutor-cupo-${Date.now()}`, 'X-Usuario-Roles': 'tutor' };
  const primera = await llamar('POST', '/inscripciones', { como: tutor, cuerpo: { turnoId: turno.id, chico: chico() } });
  const segunda = await llamar('POST', '/inscripciones', { como: tutor, cuerpo: { turnoId: turno.id, chico: chico() } });
  await esperarInscripcion(primera.body.id, tutor, (inscripcion) => inscripcion.estado === 'confirmada');
  await esperarInscripcion(segunda.body.id, tutor, (inscripcion) => inscripcion.estado === 'en_lista_de_espera');

  const actualizado = await llamar('PATCH', `/turnos/${turno.id}`, { como: ADMIN, cuerpo: { cupoTotal: 2 } });
  assert.equal(actualizado.status, 200);
  assert.equal(actualizado.body.confirmados, 2);
  assert.equal(actualizado.body.enEspera, 0);
  assert.equal(actualizado.body.disponibles, 0);
  assert.equal((await llamar('GET', `/inscripciones/${segunda.body.id}`, { como: tutor })).body.estado, 'confirmada');
});

test('cancelar una confirmada continúa la asignación en orden', async () => {
  const turno = (await llamar('POST', '/turnos', { como: ADMIN, cuerpo: { ...turnoAbierto(), cupoTotal: 1 } })).body;
  const tutor = { 'X-Usuario-Id': `tutor-baja-${Date.now()}`, 'X-Usuario-Roles': 'tutor' };
  const primera = await llamar('POST', '/inscripciones', { como: tutor, cuerpo: { turnoId: turno.id, chico: chico() } });
  const segunda = await llamar('POST', '/inscripciones', { como: tutor, cuerpo: { turnoId: turno.id, chico: chico() } });
  await esperarInscripcion(primera.body.id, tutor, (inscripcion) => inscripcion.estado === 'confirmada');
  await esperarInscripcion(segunda.body.id, tutor, (inscripcion) => inscripcion.estado === 'en_lista_de_espera');

  const cancelada = await llamar('POST', `/inscripciones/${primera.body.id}/cancelaciones`, {
    como: ADMIN, cuerpo: { motivo: 'Libera la plaza.' },
  });
  assert.equal(cancelada.status, 200);
  assert.equal(cancelada.body.estado, 'cancelada');
  await esperarInscripcion(segunda.body.id, tutor, (inscripcion) => inscripcion.estado === 'confirmada');
  const detalle = await llamar('GET', `/turnos/${turno.id}`, { como: tutor });
  assert.equal(detalle.body.confirmados, 1);
  assert.equal(detalle.body.enEspera, 0);
});

test('una respuesta rápida del padrón no se adelanta a una solicitud anterior del mismo turno', async () => {
  const turno = (await llamar('POST', '/turnos', { como: ADMIN, cuerpo: { ...turnoAbierto(), cupoTotal: 1 } })).body;
  for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
    assert.ok(process.env[key], `Falta ${key}: esta prueba corre dentro de Compose`);
  }
  const db = new pg.Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  await db.connect();
  try {
    const bloqueo = await db.query(
      `INSERT INTO colonia.inscripciones
         (turno_id, convocatoria_id, tutor_id, documento, nombre, apellido, fecha_nacimiento)
       VALUES ($1, 'verano-2027', 'prueba-bloqueo', $2, 'Leo', 'Ruiz', $3)
       RETURNING id, orden_recepcion`,
      [turno.id, dniTerminadoEn('2'), nacidoHace(8)],
    );
    const tutor = { 'X-Usuario-Id': `tutor-orden-${Date.now()}`, 'X-Usuario-Roles': 'tutor' };
    const segunda = await llamar('POST', '/inscripciones', { como: tutor, cuerpo: { turnoId: turno.id, chico: chico() } });
    assert.equal(segunda.status, 202);
    assert.ok(Number(bloqueo.rows[0].orden_recepcion) < segunda.body.ordenRecepcion);

    let observada = false;
    for (let i = 0; i < 80 && !observada; i += 1) {
      const { rows } = await db.query(
        'SELECT id, estado, es_residente FROM colonia.inscripciones WHERE id IN ($1, $2)',
        [bloqueo.rows[0].id, segunda.body.id],
      );
      const anterior = rows.find((fila) => fila.id === bloqueo.rows[0].id);
      const posterior = rows.find((fila) => fila.id === segunda.body.id);
      if (posterior?.estado === 'confirmada' || posterior?.estado === 'en_lista_de_espera') {
        assert.fail(`La solicitud posterior avanzó a ${posterior.estado} con la anterior sin resolver.`);
      }
      observada = posterior?.es_residente === true
        && posterior.estado === 'pendiente_de_validacion'
        && anterior?.es_residente === null;
      if (!observada) await new Promise((resolver) => setTimeout(resolver, 100));
    }
    assert.equal(observada, true, 'La solicitud posterior no quedó consultada y pendiente detrás de la anterior.');

    await db.query('INSERT INTO colonia.salida (inscripcion_id) VALUES ($1)', [bloqueo.rows[0].id]);
    await esperarInscripcion(bloqueo.rows[0].id, ADMIN, (inscripcion) => inscripcion.estado === 'confirmada');
    await esperarInscripcion(segunda.body.id, tutor, (inscripcion) => inscripcion.estado === 'en_lista_de_espera');
  } finally {
    await db.end();
  }
});
