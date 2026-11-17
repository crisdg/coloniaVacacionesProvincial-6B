import { crearConsultaPadron } from './padron-cliente.js';
import { reservarConsulta } from './padron-limite.js';
import { crearPadronSimulado } from './padron-simulado.js';

export { ErrorPadron } from './padron-cliente.js';

export function motivoFueraDeJurisdiccion(jurisdiccion) {
  return `El chico no reside en la jurisdicción ${jurisdiccion}.`;
}

// Única composición usada por las rutas y el consumidor: cada intento obtiene
// permiso global antes de consultar el adaptador. No hay fallas de prueba activas.
export const consultarPadron = crearConsultaPadron({
  reservarConsulta,
  consultarResidencia: crearPadronSimulado(),
});
