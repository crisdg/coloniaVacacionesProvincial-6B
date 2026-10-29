import assert from 'node:assert/strict';

const bases = process.argv.slice(2);
if (!bases.length) bases.push('http://localhost:3001', 'http://localhost:8080');
const routes = [
  ['GET', '/turnos'], ['POST', '/turnos', { nombre: 'Prueba' }],
  ['GET', '/turnos/1'], ['PATCH', '/turnos/1', { cupoTotal: 40 }],
  ['GET', '/inscripciones'], ['POST', '/inscripciones', { turnoId: 1 }],
  ['GET', '/inscripciones/1'],
  ['PATCH', '/inscripciones/1', { chico: { apellido: 'Gómez' } }],
  ['POST', '/inscripciones/1/cancelaciones', { motivo: 'Solicitud de baja del tutor' }],
];
for (const base of bases) {
  const page = await fetch(base, { signal: AbortSignal.timeout(10000) });
  assert.equal(page.status, 200, base + ' página');
  const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(10000) });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', database: 'ok', stage: 'esqueleto' });
  for (const [method, path, body] of routes) {
    const response = await fetch(base + '/api' + path, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 501, method + ' ' + path);
    assert.match(response.headers.get('content-type'), /application\/problem\+json/);
    const problem = await response.json();
    assert.equal(problem.status, 501);
    assert.equal(problem.instance, path);
  }
  const missing = await fetch(base + '/api/no-existe');
  assert.equal(missing.status, 404);
  const malformed = await fetch(base + '/api/turnos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  console.log('OK: página, health, ' + routes.length + ' operaciones 501, ruta 404 y JSON inválido 400 en ' + base);
}

