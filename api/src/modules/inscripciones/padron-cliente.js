import { VIGENCIA_PERMISO_MS } from './padron-config.js';

export class ErrorPadron extends Error {
  constructor(mensaje, { codigo = 'NO_DISPONIBLE', reintentarEnMs } = {}) {
    super(mensaje);
    this.name = 'ErrorPadron';
    this.codigo = codigo;
    if (reintentarEnMs !== undefined) this.reintentarEnMs = reintentarEnMs;
  }
}

// El adaptador recibe (documento, jurisdiccion) y resuelve un booleano.
// Una falla técnica rechaza la promesa: nunca equivale a "no reside".
export function crearConsultaPadron({
  reservarConsulta,
  consultarResidencia,
  esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  ahora = () => performance.now(),
}) {
  return async function consultarPadron(documento, jurisdiccion, { esperaMaximaMs = Infinity } = {}) {
    if (typeof jurisdiccion !== 'string' || jurisdiccion.trim() === '') {
      throw new ErrorPadron('La convocatoria no tiene jurisdicción.', { codigo: 'JURISDICCION_INVALIDA' });
    }
    const inicio = ahora();
    for (;;) {
      // Medir desde ANTES de pedir permiso es conservador: incluye red, espera
      // del lock y commit. No se comparan relojes de distintos servidores.
      const inicioReserva = ahora();
      const esperaMs = await reservarConsulta();
      const transcurrido = ahora() - inicio;
      if (transcurrido > esperaMaximaMs) {
        throw new ErrorPadron('Se alcanzó el tope de consultas al padrón.', { codigo: 'LIMITE_LOCAL' });
      }
      if (esperaMs === 0 && ahora() - inicioReserva < VIGENCIA_PERMISO_MS) {
        // Iniciar directamente: no agregar awaits entre la vigencia y el adaptador.
        const residente = await consultarResidencia(documento, jurisdiccion);
        if (typeof residente !== 'boolean') {
          throw new ErrorPadron('El padrón devolvió una respuesta inválida.', { codigo: 'RESPUESTA_INVALIDA' });
        }
        return residente;
      }
      // Un permiso vencido no se reintegra: permanece contado hasta su caducidad.
      const demora = esperaMs || 1;
      if (transcurrido + demora > esperaMaximaMs) {
        throw new ErrorPadron('Se alcanzó el tope de consultas al padrón.', { codigo: 'LIMITE_LOCAL' });
      }
      await esperar(demora);
    }
  };
}
