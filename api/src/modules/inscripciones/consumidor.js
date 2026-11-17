import { randomUUID } from 'node:crypto';
import { crearPool, enTransaccion } from '../../db.js';
import { asignarTurno } from './asignacion.js';
import { consultarPadron } from './padron.js';

// Solo consultas cortas: ninguna conexión queda retenida esperando al padrón.
export const poolConsumidor = crearPool();
const VIGENCIA_MS = 60000;
const RENOVACION_MS = 20000;

// false conserva el mensaje para reentrega: dueño activo, vencido o invalidado.
export async function resolverInscripcion(inscripcionId, consultar = consultarPadron) {
  const token = randomUUID();
  const { rows: [previa] } = await poolConsumidor.query(
    `UPDATE colonia.inscripciones i
     SET padron_token = $2, padron_reclamado_hasta = clock_timestamp() + $3 * interval '1 millisecond'
     FROM colonia.convocatorias c
     WHERE i.id = $1 AND c.id = i.convocatoria_id
       AND i.estado = 'pendiente_de_validacion' AND i.es_residente IS NULL
       AND (i.padron_token IS NULL OR i.padron_reclamado_hasta <= clock_timestamp())
     RETURNING i.documento, i.turno_id, c.jurisdiccion`,
    [inscripcionId, token, VIGENCIA_MS],
  );
  if (!previa) {
    const { rows: [fila] } = await poolConsumidor.query(
      'SELECT estado, es_residente FROM colonia.inscripciones WHERE id = $1', [inscripcionId],
    );
    return !fila || fila.estado !== 'pendiente_de_validacion' || fila.es_residente !== null;
  }

  let perdida = false;
  let renovando = Promise.resolve();
  let timer;
  const programar = () => {
    timer = setTimeout(() => {
      renovando = poolConsumidor.query(
        `UPDATE colonia.inscripciones
         SET padron_reclamado_hasta = clock_timestamp() + $3 * interval '1 millisecond'
         WHERE id = $1 AND padron_token = $2 AND padron_reclamado_hasta > clock_timestamp()`,
        [inscripcionId, token, VIGENCIA_MS],
      ).then(({ rowCount }) => { perdida = rowCount !== 1; })
        .catch(() => { perdida = true; })
        .then(() => { if (!perdida) programar(); });
    }, RENOVACION_MS);
    timer.unref();
  };
  const detener = async () => { clearTimeout(timer); await renovando; clearTimeout(timer); };
  programar();
  try {
    const residente = await consultar(previa.documento, previa.jurisdiccion);
    await detener();
    if (perdida) return false;
    return await enTransaccion(async client => {
      // Mismo orden de locks que cancelaciones y asignador.
      await client.query('SELECT id FROM colonia.turnos WHERE id = $1 FOR UPDATE', [previa.turno_id]);
      await client.query('SELECT id FROM colonia.inscripciones WHERE id = $1 FOR UPDATE', [inscripcionId]);
      const { rowCount } = await client.query(
        `UPDATE colonia.inscripciones SET es_residente = $3, padron_consultado_en = clock_timestamp(),
           padron_token = NULL, padron_reclamado_hasta = NULL
         WHERE id = $1 AND padron_token = $2 AND padron_reclamado_hasta > clock_timestamp()
           AND estado = 'pendiente_de_validacion' AND es_residente IS NULL`,
        [inscripcionId, token, residente],
      );
      if (!rowCount) return false;
      await asignarTurno(previa.turno_id, client);
      return true;
    });
  } finally {
    await detener();
    // Nunca liberar la reclamación de un sucesor. Si la base cayó, vence sola.
    await poolConsumidor.query(
      `UPDATE colonia.inscripciones SET padron_token = NULL, padron_reclamado_hasta = NULL
       WHERE id = $1 AND padron_token = $2`, [inscripcionId, token],
    ).catch(() => {});
  }
}
