import assert from 'node:assert/strict';
import { test } from 'node:test';

const GATEWAY = process.env.E6_GATEWAY_URL ?? 'http://localhost:8000';
const ADMIN = process.env.E6_ADMIN_TOKEN;
const TUTOR_A = process.env.E6_TUTOR_A_TOKEN;
const TUTOR_B = process.env.E6_TUTOR_B_TOKEN;

async function llamar(metodo, ruta, { token, headers = {}, cuerpo } = {}) {
  const respuesta = await fetch(new URL(ruta, GATEWAY), {
    method: metodo,
    headers: {
      ...(cuerpo !== undefined && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  const texto = await respuesta.text();
  return {
    status: respuesta.status,
    headers: respuesta.headers,
    body: texto ? JSON.parse(texto) : undefined,
  };
}

function esProblema(respuesta, status) {
  assert.equal(respuesta.status, status, JSON.stringify(respuesta.body));
  assert.match(respuesta.headers.get('content-type'), /application\/problem\+json/);
  assert.equal(respuesta.body.status, status);
}

function claims(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

function fechaEn(dias) {
  const fecha = new Date(Date.now() + dias * 24 * 60 * 60_000);
  return fecha.toISOString().slice(0, 10);
}

function dniDePrueba() {
  const numero = String(10_000_000 + Math.floor(Math.random() * 89_999_999));
  return numero.endsWith('0') ? `${numero.slice(0, -1)}1` : numero;
}

test('E6: autenticación, autorización, titularidad e identidad confiada solo del token', async (t) => {
  assert.ok(ADMIN && TUTOR_A && TUTOR_B,
    'Definí E6_ADMIN_TOKEN, E6_TUTOR_A_TOKEN y E6_TUTOR_B_TOKEN con access tokens vigentes.');
  assert.notEqual(claims(ADMIN).sub, claims(TUTOR_A).sub, 'El token de administrador debe ser distinto.');
  assert.notEqual(claims(TUTOR_A).sub, claims(TUTOR_B).sub, 'Se necesitan dos usuarios tutor distintos.');
  assert.ok(claims(ADMIN).realm_access?.roles?.includes('administrador'), 'El token admin no tiene ese rol.');
  assert.ok(claims(TUTOR_A).realm_access?.roles?.includes('tutor'), 'El token tutor A no tiene ese rol.');
  assert.ok(claims(TUTOR_B).realm_access?.roles?.includes('tutor'), 'El token tutor B no tiene ese rol.');

  await t.test('sin token y con token inválido responde 401', async () => {
    esProblema(await llamar('GET', '/turnos'), 401);
    esProblema(await llamar('GET', '/turnos', { token: 'no-es-un-jwt' }), 401);
  });

  await t.test('un tutor no puede crear turnos aunque falsifique el header de rol', async () => {
    const respuesta = await llamar('POST', '/turnos', {
      token: TUTOR_A,
      headers: { 'X-Usuario-Id': claims(ADMIN).sub, 'X-Usuario-Roles': 'administrador' },
      cuerpo: {},
    });
    esProblema(respuesta, 403);
  });

  let inscripcionId;
  await t.test('headers de identidad falsificados no cambian el titular y la inscripción ajena devuelve 404', async () => {
    const inicio = fechaEn(10);
    const turno = await llamar('POST', '/turnos', {
      token: ADMIN,
      cuerpo: {
        convocatoriaId: 'verano-2027',
        sedeId: 1,
        nombre: `E6 ${Date.now()}`,
        fechaInicio: inicio,
        fechaFin: fechaEn(30),
        inscripcionAbreEn: new Date(Date.now() - 60_000).toISOString(),
        inscripcionCierraEn: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        cupoTotal: 1,
      },
    });
    assert.equal(turno.status, 201, JSON.stringify(turno.body));

    const nacimiento = new Date();
    nacimiento.setUTCFullYear(nacimiento.getUTCFullYear() - 8);
    nacimiento.setUTCDate(nacimiento.getUTCDate() - 10);
    const alta = await llamar('POST', '/inscripciones', {
      token: TUTOR_A,
      headers: {
        'X-Usuario-Id': claims(TUTOR_B).sub,
        'X-Usuario-Roles': 'administrador',
        'Idempotency-Key': `e6-${crypto.randomUUID()}`,
      },
      cuerpo: {
        turnoId: turno.body.id,
        chico: {
          documento: dniDePrueba(),
          nombre: 'Prueba',
          apellido: 'E6',
          fechaNacimiento: nacimiento.toISOString().slice(0, 10),
        },
      },
    });
    assert.equal(alta.status, 202, JSON.stringify(alta.body));
    inscripcionId = alta.body.id;

    const propiaConHeadersFalsos = await llamar('GET', `/inscripciones/${inscripcionId}`, {
      token: TUTOR_A,
      headers: { 'X-Usuario-Id': claims(TUTOR_B).sub, 'X-Usuario-Roles': 'tutor' },
    });
    assert.equal(propiaConHeadersFalsos.status, 200, JSON.stringify(propiaConHeadersFalsos.body));
    assert.equal(propiaConHeadersFalsos.body.id, inscripcionId);

    const ajena = await llamar('GET', `/inscripciones/${inscripcionId}`, { token: TUTOR_B });
    esProblema(ajena, 404);
  });
});
