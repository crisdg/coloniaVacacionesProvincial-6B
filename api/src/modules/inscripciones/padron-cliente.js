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
  ahora = Date.now,
}) {
  return async function consultarPadron(documento, jurisdiccion, { esperaMaximaMs = Infinity } = {}) {
    if (typeof jurisdiccion !== 'string' || jurisdiccion.trim() === '') {
      throw new ErrorPadron('La convocatoria no tiene jurisdicción.', { codigo: 'JURISDICCION_INVALIDA' });
    }
    const inicio = ahora();
    for (;;) {
      const esperaMs = await reservarConsulta();
      if (esperaMs === 0) break;
      if (ahora() - inicio + esperaMs > esperaMaximaMs) {
        throw new ErrorPadron('Se alcanzó el tope de consultas al padrón.', { codigo: 'LIMITE_LOCAL' });
      }
      await esperar(esperaMs);
    }
    const residente = await consultarResidencia(documento, jurisdiccion);
    if (typeof residente !== 'boolean') {
      throw new ErrorPadron('El padrón devolvió una respuesta inválida.', { codigo: 'RESPUESTA_INVALIDA' });
    }
    return residente;
  };
}
