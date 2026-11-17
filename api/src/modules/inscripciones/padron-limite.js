import { enTransaccion } from '../../db.js';
import { leerTopePadron, VENTANA_PADRON_MS, VIGENCIA_PERMISO_MS } from './padron-config.js';

const TOPE = leerTopePadron();
const RETENCION_MS = VENTANA_PADRON_MS + VIGENCIA_PERMISO_MS;
const LOCK_PADRON = 727002;

// La exclusión global cubre únicamente contar/limpiar/insertar, nunca la espera
// ni la consulta externa. Cada sentencia posterior al lock ve los commits previos.
// Devuelve 0 si obtuvo permiso, o los ms hasta que venza el permiso más antiguo.
export async function reservarConsulta() {
  return enTransaccion(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_PADRON]);
    const { rows } = await client.query(
      `WITH reloj AS MATERIALIZED (SELECT clock_timestamp() AS ahora),
       vigentes AS MATERIALIZED (
         SELECT count(*)::int AS cantidad, min(concedido_en) AS primero
         FROM colonia.permisos_padron, reloj
         WHERE concedido_en > ahora - $2 * interval '1 millisecond'
       ),
       limpieza AS (
         DELETE FROM colonia.permisos_padron USING reloj
         WHERE concedido_en <= ahora - $2 * interval '1 millisecond'
       ),
       permiso AS (
         INSERT INTO colonia.permisos_padron (concedido_en)
         SELECT ahora FROM reloj, vigentes WHERE cantidad < $1 RETURNING id
       )
       SELECT CASE WHEN EXISTS (SELECT 1 FROM permiso) THEN 0
         ELSE greatest(1, ceil(extract(epoch FROM (
           primero + $2 * interval '1 millisecond' - ahora
         )) * 1000)::int) END AS espera
       FROM reloj, vigentes`,
      [TOPE, RETENCION_MS],
    );
    return rows[0].espera;
  });
}
