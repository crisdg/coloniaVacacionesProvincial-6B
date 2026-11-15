// Pruebas de contrato contra la API en la red de Compose, con la identidad que pondría el gateway.
// docker compose -f docker-compose.yml -f docker-compose.auth.yml run --rm --no-deps -v ./api/test:/app/test api node --test test/api.test.mjs
import assert from 'node:assert/strict';
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
const dniAlAzar = () => String(10_000_000 + Math.floor(Math.random() * 89_999_999));
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

  const corregida = await llamar('PATCH', `/inscripciones/${alta.body.id}`, { como: ADMIN, cuerpo: { chico: { apellido: 'Pérez' } } });
  assert.equal(corregida.status, 200);
  assert.equal(corregida.body.chico.apellido, 'Pérez');
  assert.equal(corregida.body.ordenRecepcion, alta.body.ordenRecepcion);
  assert.equal(corregida.body.estado, 'pendiente_de_validacion');
  esProblema(await llamar('PATCH', `/inscripciones/${alta.body.id}`, { como: ADMIN, cuerpo: { chico: { documento: dniAlAzar() } } }), 501);
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
