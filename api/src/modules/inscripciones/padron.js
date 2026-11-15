import { enTransaccion } from '../../db.js';

// El padrón provincial no existe en este entorno: un DNI que termina en 0 no reside
// en la jurisdicción de la convocatoria. Cualquier otro DNI de 7 u 8 dígitos sí.
export function motivoFueraDeJurisdiccion(jurisdiccion) {
  return `El chico no reside en la jurisdicción ${jurisdiccion}.`;
}

export class ErrorPadron extends Error {}

function topePorSegundo() {
  const valor = Number(process.env.PADRON_CONSULTAS_POR_SEGUNDO ?? 50);
  return Number.isInteger(valor) && valor > 0 ? valor : 50;
}

const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

// Reserva una consulta del cupo global. Devuelve 0 si la obtuvo, o cuántos milisegundos
// faltan para el próximo segundo si este ya llegó al tope.
async function reservarConsulta() {
  const tope = topePorSegundo();
  return enTransaccion(async (client) => {
    const reserva = await client.query(
      `INSERT INTO colonia.consultas_padron (segundo, cantidad)
       VALUES (date_trunc('second', clock_timestamp()), 1)
       ON CONFLICT (segundo) DO UPDATE
         SET cantidad = colonia.consultas_padron.cantidad + 1
         WHERE colonia.consultas_padron.cantidad < $1
       RETURNING cantidad`,
      [tope],
    );
    if (reserva.rows.length) {
      await client.query(
        `DELETE FROM colonia.consultas_padron WHERE segundo < clock_timestamp() - interval '2 minutes'`,
      );
      return 0;
    }
    const { rows } = await client.query(
      `SELECT ceil(extract(epoch FROM (
         date_trunc('second', clock_timestamp()) + interval '1 second' - clock_timestamp()
       )) * 1000)::int AS espera`,
    );
    return Math.max(rows[0].espera, 1);
  });
}

// Toda consulta pasa por acá, también los reintentos: no hay otra forma de hablar con el padrón.
export async function consultarPadron(documento, jurisdiccion, { esperaMaximaMs = Infinity } = {}) {
  if (typeof jurisdiccion !== 'string' || jurisdiccion.trim() === '') {
    throw new ErrorPadron('La convocatoria no tiene jurisdicción.');
  }
  const inicio = Date.now();
  for (;;) {
    const esperaMs = await reservarConsulta();
    if (esperaMs === 0) break;
    if (Date.now() - inicio + esperaMs > esperaMaximaMs) {
      throw new ErrorPadron('Se alcanzó el tope de consultas al padrón.');
    }
    await esperar(esperaMs);
  }
  return !documento.endsWith('0');
}
