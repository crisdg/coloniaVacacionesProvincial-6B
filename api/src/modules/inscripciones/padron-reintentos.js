import { setTimeout as esperar } from 'node:timers/promises';

export const TIMEOUT_INTENTO_MS = 30000;
export const TIMEOUT_CONSULTA_MS = 10000;

export function demoraReintento(intentos, error) {
  const creciente = Math.min(60000, 1000 * 2 ** Math.min(16, Math.max(0, intentos - 1)));
  const sugerida = error?.codigo === 'SATURADO' && Number.isFinite(error.reintentarEnMs)
    ? Math.max(0, error.reintentarEnMs) : 0;
  return Math.max(creciente, sugerida);
}

// Abort cooperativo y límite local incluso si el adaptador ignora la señal.
// Promise.race consume también el rechazo tardío; nunca vuelve a persistirlo.
export async function conTimeout(trabajo, ms, signal) {
  const control = new AbortController();
  const cancelar = () => control.abort(signal.reason);
  if (signal?.aborted) cancelar();
  else signal?.addEventListener('abort', cancelar, { once: true });
  const error = Object.assign(new Error('Se agotó el tiempo de consulta al padrón.'), { codigo: 'TIMEOUT' });
  const timer = setTimeout(() => control.abort(error), ms);
  let alAbortar;
  try {
    control.signal.throwIfAborted();
    const cancelada = new Promise((_, reject) => {
      alAbortar = () => reject(control.signal.reason);
      control.signal.addEventListener('abort', alAbortar, { once: true });
    });
    return await Promise.race([trabajo(control.signal), cancelada]);
  } finally {
    clearTimeout(timer);
    control.signal.removeEventListener('abort', alAbortar);
    signal?.removeEventListener('abort', cancelar);
  }
}

export const esperarPadron = (ms, signal) => esperar(ms, undefined, { signal });
