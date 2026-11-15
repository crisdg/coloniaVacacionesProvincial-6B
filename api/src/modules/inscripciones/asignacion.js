import { enTransaccion } from '../../db.js';
import { motivoFueraDeJurisdiccion } from './padron.js';

// Asigna en orden de recepción dentro del turno. Se detiene en la primera solicitud
// pendiente sin respuesta del padrón: una respuesta más rápida no se adelanta.
// El turno tiene que estar bloqueado por quien llama, o se bloquea acá, y siempre
// antes que las inscripciones, para no cruzar locks con una cancelación o un cambio de cupo.
export async function asignarTurno(turnoId, db) {
  if (!db) return enTransaccion((client) => asignarTurno(turnoId, client));
  await db.query('SELECT id FROM colonia.turnos WHERE id = $1 FOR UPDATE', [turnoId]);
  const cupo = await db.query('SELECT cupo_total FROM colonia.turnos WHERE id = $1', [turnoId]);
  if (!cupo.rows.length) return;
  const ocupadas = await db.query(
    `SELECT count(*)::int AS n FROM colonia.inscripciones WHERE turno_id = $1 AND estado = 'confirmada'`,
    [turnoId],
  );
  let confirmados = ocupadas.rows[0].n;
  const { rows } = await db.query(
    `SELECT i.id, i.estado, i.es_residente, c.jurisdiccion
     FROM colonia.inscripciones i
     JOIN colonia.convocatorias c ON c.id = i.convocatoria_id
     WHERE i.turno_id = $1 AND i.estado IN ('pendiente_de_validacion', 'en_lista_de_espera')
     ORDER BY i.orden_recepcion
     FOR UPDATE OF i`,
    [turnoId],
  );
  for (const fila of rows) {
    if (fila.estado === 'pendiente_de_validacion') {
      if (fila.es_residente === null) break;
      if (!fila.es_residente) {
        await db.query(
          `UPDATE colonia.inscripciones SET estado = 'rechazada', motivo_rechazo = $2 WHERE id = $1`,
          [fila.id, motivoFueraDeJurisdiccion(fila.jurisdiccion)],
        );
        continue;
      }
    }
    if (confirmados < cupo.rows[0].cupo_total) {
      await db.query(
        `UPDATE colonia.inscripciones SET estado = 'confirmada', motivo_rechazo = NULL WHERE id = $1`,
        [fila.id],
      );
      confirmados += 1;
    } else if (fila.estado === 'pendiente_de_validacion') {
      await db.query(
        `UPDATE colonia.inscripciones SET estado = 'en_lista_de_espera' WHERE id = $1`,
        [fila.id],
      );
    }
  }
}
