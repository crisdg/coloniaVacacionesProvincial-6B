import { enTransaccion } from '../../db.js';
import { motivoFueraDeJurisdiccion } from './padron.js';

// El turno serializa admisión, resultados, correcciones, cancelaciones y cupos.
// No usar SKIP LOCKED: saltarse una solicitud alteraría la prioridad.
export async function asignarTurno(turnoId, db) {
  if (!db) return enTransaccion((client) => asignarTurno(turnoId, client));
  const { rows: [turno] } = await db.query(
    'SELECT cupo_total FROM colonia.turnos WHERE id = $1 FOR UPDATE', [turnoId],
  );
  if (!turno) return;
  // No se bloquea la cola completa. La primera residencia desconocida marca
  // un límite estable mientras conservamos el lock del turno.
  const { rows: [barrera] } = await db.query(
    `SELECT orden_recepcion FROM colonia.inscripciones
     WHERE turno_id = $1 AND estado = 'pendiente_de_validacion' AND es_residente IS NULL
     ORDER BY orden_recepcion LIMIT 1`, [turnoId],
  );
  // bigint se conserva como texto: Number perdería precisión para órdenes grandes.
  const hasta = barrera ? (BigInt(barrera.orden_recepcion) - 1n).toString() : '9223372036854775807';
  const { rows: [ocupadas] } = await db.query(
    `SELECT count(*)::int AS n FROM colonia.inscripciones WHERE turno_id = $1 AND estado = 'confirmada'`,
    [turnoId],
  );
  const disponibles = Math.max(0, turno.cupo_total - ocupadas.n);
  if (disponibles > 0) {
    await db.query(
      `WITH elegidas AS (
         SELECT id FROM colonia.inscripciones
         WHERE turno_id = $1 AND orden_recepcion <= $2::bigint
           AND (estado = 'en_lista_de_espera'
                OR (estado = 'pendiente_de_validacion' AND es_residente = true))
         ORDER BY orden_recepcion LIMIT $3 FOR UPDATE
       )
       UPDATE colonia.inscripciones i SET estado = 'confirmada', motivo_rechazo = NULL
       FROM elegidas e WHERE i.id = e.id`,
      [turnoId, hasta, disponibles],
    );
  }
  // Solo resultados nuevos anteriores a la barrera. Las filas que ya están
  // en espera y no obtuvieron cupo no se leen ni se bloquean.
  await db.query(
    `UPDATE colonia.inscripciones i SET estado = 'rechazada', motivo_rechazo = replace($3, '{jurisdiccion}', c.jurisdiccion)
     FROM colonia.convocatorias c
     WHERE i.turno_id = $1 AND i.orden_recepcion <= $2::bigint
       AND i.estado = 'pendiente_de_validacion' AND i.es_residente = false
       AND c.id = i.convocatoria_id`,
    [turnoId, hasta, motivoFueraDeJurisdiccion('{jurisdiccion}')],
  );
  await db.query(
    `UPDATE colonia.inscripciones SET estado = 'en_lista_de_espera'
     WHERE turno_id = $1 AND orden_recepcion <= $2::bigint
       AND estado = 'pendiente_de_validacion' AND es_residente = true`,
    [turnoId, hasta],
  );
}
