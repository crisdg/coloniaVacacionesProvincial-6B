import { conflicto, invalido } from '../../shared/problem.js';

export function validarClaveIdempotencia(valor) {
  if (valor === undefined) return undefined;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(valor)) {
    throw invalido('Idempotency-Key debe tener de 1 a 128 caracteres: letras, números, punto, guion, guion bajo o dos puntos.');
  }
  return valor;
}

// Siempre dentro de la transacción de admisión. La PK coordina incluso distintas
// réplicas: un INSERT competidor espera el commit/rollback de la primera reserva.
export async function conIdempotencia(client, tutorId, clave, solicitud, crear) {
  if (clave === undefined) return crear();
  const datos = [tutorId, clave, JSON.stringify(solicitud)];
  const reserva = await client.query(
    `INSERT INTO colonia.solicitudes_idempotentes (tutor_id, clave, solicitud)
     VALUES ($1, $2, $3::jsonb) ON CONFLICT (tutor_id, clave) DO NOTHING RETURNING clave`,
    datos,
  );
  if (!reserva.rows.length) {
    const { rows: [previa] } = await client.query(
      `SELECT solicitud = $3::jsonb AS coincide, respuesta
       FROM colonia.solicitudes_idempotentes WHERE tutor_id = $1 AND clave = $2`,
      datos,
    );
    if (!previa.coincide) throw conflicto('Idempotency-Key ya fue utilizada con otra solicitud.');
    if (previa.respuesta === null) throw new Error('Reserva idempotente confirmada sin respuesta.');
    return previa.respuesta;
  }
  const respuesta = await crear();
  await client.query(
    `UPDATE colonia.solicitudes_idempotentes SET respuesta = $3::jsonb WHERE tutor_id = $1 AND clave = $2`,
    [tutorId, clave, JSON.stringify(respuesta)],
  );
  return respuesta;
}
