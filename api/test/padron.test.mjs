import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crearConsultaPadron, ErrorPadron } from '../src/modules/inscripciones/padron-cliente.js';
import { crearPadronSimulado } from '../src/modules/inscripciones/padron-simulado.js';

test('el adaptador conserva la regla de residencia de la demo', async () => {
  const padron = crearPadronSimulado();
  assert.equal(await padron('91000001', 'Provincia'), true);
  assert.equal(await padron('91000000', 'Provincia'), false);
});

test('el cliente espera el permiso y transmite documento y jurisdicción al adaptador', async () => {
  const eventos = [];
  let intentos = 0;
  let reloj = 0;
  const consultar = crearConsultaPadron({
    reservarConsulta: async () => { eventos.push('permiso'); return intentos++ === 0 ? 100 : 0; },
    esperar: async ms => { eventos.push(['espera', ms]); reloj += ms; },
    ahora: () => reloj,
    consultarResidencia: async (...args) => { eventos.push(args); return false; },
  });
  assert.equal(await consultar('91000000', 'Provincia'), false);
  assert.deepEqual(eventos, ['permiso', ['espera', 100], 'permiso', ['91000000', 'Provincia']]);
});

test('el presupuesto de espera del regulador no dispara una consulta externa', async () => {
  let reloj = 0;
  let llamadas = 0;
  const consultar = crearConsultaPadron({
    reservarConsulta: async () => 100,
    esperar: async ms => { reloj += ms; },
    ahora: () => reloj,
    consultarResidencia: async () => { llamadas++; return true; },
  });
  await assert.rejects(consultar('91000001', 'Provincia', { esperaMaximaMs: 150 }),
    error => error instanceof ErrorPadron && error.codigo === 'LIMITE_LOCAL');
  assert.equal(reloj, 100);
  assert.equal(llamadas, 0);
});

test('una falla transitoria y una saturación no equivalen a no residente; cada intento pide permiso', async () => {
  let permisos = 0;
  const consultar = crearConsultaPadron({
    reservarConsulta: async () => { permisos++; return 0; },
    consultarResidencia: crearPadronSimulado({ escenarios: [
      { error: 'NO_DISPONIBLE' }, { error: 'SATURADO', reintentarEnMs: 2500 },
    ] }),
  });
  await assert.rejects(consultar('91000001', 'Provincia'),
    error => error instanceof ErrorPadron && error.codigo === 'NO_DISPONIBLE');
  await assert.rejects(consultar('91000001', 'Provincia'),
    error => error instanceof ErrorPadron && error.codigo === 'SATURADO' && error.reintentarEnMs === 2500);
  assert.equal(await consultar('91000001', 'Provincia'), true);
  assert.equal(permisos, 3);
});

test('la demora es controlable y los escenarios se asignan por inicio, no por finalización', async () => {
  let liberar;
  const pausa = new Promise(resolve => { liberar = resolve; });
  const demoras = [];
  const padron = crearPadronSimulado({
    escenarios: [{ demoraMs: 500 }, { error: 'SATURADO' }],
    esperar: ms => { demoras.push(ms); return pausa; },
  });
  let terminada = false;
  const lenta = padron('91000001', 'Provincia').then(valor => { terminada = true; return valor; });
  try {
    await assert.rejects(padron('91000001', 'Provincia'), { codigo: 'SATURADO' });
    assert.equal(terminada, false);
    assert.deepEqual(demoras, [500]);
    // No hay configuración global que contamine otra instancia o la demo.
    assert.equal(await crearPadronSimulado()('91000001', 'Provincia'), true);
  } finally {
    liberar();
  }
  assert.equal(await lenta, true);
});

test('una respuesta externa inválida es un error técnico', async () => {
  const consultar = crearConsultaPadron({ reservarConsulta: async () => 0, consultarResidencia: async () => null });
  await assert.rejects(consultar('91000001', 'Provincia'), { codigo: 'RESPUESTA_INVALIDA' });
});

test('sin jurisdicción no se consume permiso ni se consulta el adaptador', async () => {
  const inesperado = async () => assert.fail('No debe consultarse sin jurisdicción.');
  const consultar = crearConsultaPadron({ reservarConsulta: inesperado, consultarResidencia: inesperado });
  await assert.rejects(consultar('91000001', ' '), { codigo: 'JURISDICCION_INVALIDA' });
});

test('los escenarios rechazan configuraciones inválidas al construirse', () => {
  for (const escenario of [{ demoraMs: -1 }, { error: 'ERROR_DESCONOCIDO' }, { reintentarEnMs: NaN }]) {
    assert.throws(() => crearPadronSimulado({ escenarios: [escenario] }), TypeError);
  }
});
