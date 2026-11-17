import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conTimeout, demoraReintento } from '../src/modules/inscripciones/padron-reintentos.js';
import { crearConsultaPadron } from '../src/modules/inscripciones/padron-cliente.js';

test('backoff creciente acotado y saturación respetada sin acortar la espera', () => {
  assert.deepEqual([1, 2, 3, 7, 100].map(n => demoraReintento(n)), [1000, 2000, 4000, 60000, 60000]);
  assert.equal(demoraReintento(2, { codigo: 'SATURADO', reintentarEnMs: 90000 }), 90000);
  for (const reintentarEnMs of [0, -1, NaN, Infinity, '20000']) {
    assert.equal(demoraReintento(2, { codigo: 'SATURADO', reintentarEnMs }), 2000);
  }
});

test('timeout cancela cooperativamente y descarta respuestas tardías', async () => {
  let signal;
  let completar;
  const tarea = conTimeout(s => { signal = s; return new Promise(resolve => { completar = resolve; }); }, 10);
  await assert.rejects(tarea, { codigo: 'TIMEOUT' });
  assert.equal(signal.aborted, true);
  completar(true);
});

test('una señal cancelada no inicia la consulta', async () => {
  const control = new AbortController();
  control.abort(new Error('Cancelado'));
  await assert.rejects(conTimeout(() => assert.fail('No iniciar'), 1000, control.signal), /Cancelado/);
});

test('el cliente limita la consulta externa sin convertir timeout en no residente', async () => {
  const consultar = crearConsultaPadron({
    reservarConsulta: async () => 0,
    consultarResidencia: () => new Promise(() => {}),
  });
  await assert.rejects(consultar('91000001', 'Provincia', { timeoutMs: 10 }), { codigo: 'TIMEOUT' });
});

test('cancelar mientras se espera permiso impide iniciar una consulta después', async () => {
  const control = new AbortController();
  const consultar = crearConsultaPadron({
    reservarConsulta: async () => { control.abort(new Error('Fin del intento')); return 0; },
    consultarResidencia: () => assert.fail('No consultar luego de cancelar'),
  });
  await assert.rejects(consultar('91000001', 'Provincia', { signal: control.signal }), /Fin del intento/);
});
