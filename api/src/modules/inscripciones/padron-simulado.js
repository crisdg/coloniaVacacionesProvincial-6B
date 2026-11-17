import { ErrorPadron } from './padron-cliente.js';
import { esperarPadron } from './padron-reintentos.js';

// Cada instancia consume sus escenarios en orden de inicio de llamada, incluso
// con concurrencia. Al agotarlos vuelve al comportamiento normal, sin azar.
// Las pruebas pueden inyectar una espera controlada en lugar de dormir realmente.
export function crearPadronSimulado({
  escenarios = [],
  esperar = esperarPadron,
} = {}) {
  const pasos = escenarios.map(({ demoraMs = 0, error, reintentarEnMs = 1000 }) => {
    if (!Number.isFinite(demoraMs) || demoraMs < 0
      || !Number.isFinite(reintentarEnMs) || reintentarEnMs < 0
      || (error !== undefined && !['NO_DISPONIBLE', 'SATURADO'].includes(error))) {
      throw new TypeError('Escenario de padrón inválido.');
    }
    return { demoraMs, error, reintentarEnMs };
  });
  let siguiente = 0;
  return async function consultarResidencia(documento, jurisdiccion, { signal } = {}) {
    signal?.throwIfAborted();
    const paso = pasos[siguiente++] ?? {};
    if (paso.demoraMs) await esperar(paso.demoraMs, signal);
    signal?.throwIfAborted();
    if (paso.error === 'NO_DISPONIBLE') {
      throw new ErrorPadron('El padrón simulado no está disponible.');
    }
    if (paso.error === 'SATURADO') {
      // Equivalente al rechazo externo por tasa (HTTP 429), no al límite local.
      throw new ErrorPadron('El padrón simulado está saturado.', {
        codigo: 'SATURADO', reintentarEnMs: paso.reintentarEnMs,
      });
    }
    // Regla original de la demo, sin cambios.
    return !documento.endsWith('0');
  };
}
