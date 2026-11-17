import { crearPool } from '../../db.js';
import { asignarTurno } from './asignacion.js';
import { consultarPadron } from './padron.js';

// Separado del pool de rutas/outbox/permisos: los consumidores esperan al padrón
// con una sesión reservada y no deben agotar las conexiones que dan sus permisos.
export const poolConsumidor = crearPool();
const LOCK_INSCRIPCION = 727003;

// true: resultado durable o nada pendiente; false: otra réplica tiene el trabajo.
export async function resolverInscripcion(inscripcionId, consultar = consultarPadron) {
  const client = await poolConsumidor.connect();
  let adquirido = false;
  let descartar = false;
  // Si se pierde esta sesión no puede persistirse el resultado con otra conexión.
  const conexionPerdida = () => { descartar = true; };
  client.on('error', conexionPerdida);
  try {
    const { rows: [lock] } = await client.query(
      'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS adquirido',
      [LOCK_INSCRIPCION, inscripcionId],
    );
    adquirido = lock.adquirido;
    if (!adquirido) return false;
    const { rows: [previa] } = await client.query(
      `SELECT i.turno_id, i.documento, i.estado, i.es_residente, c.jurisdiccion
       FROM colonia.inscripciones i
       JOIN colonia.convocatorias c ON c.id = i.convocatoria_id WHERE i.id = $1`,
      [inscripcionId],
    );
    // Residencia y asignación se guardan juntas. Una reentrega tras commit no
    // necesita consultar ni ejecutar de nuevo el asignador, aun si espera orden.
    if (!previa || previa.estado !== 'pendiente_de_validacion' || previa.es_residente !== null) return true;

    // Fuera de la transacción y sin bloquear el turno ni la fila de inscripción.
    const residente = await consultar(previa.documento, previa.jurisdiccion);
    await client.query('BEGIN');
    await client.query('SELECT id FROM colonia.turnos WHERE id = $1 FOR UPDATE', [previa.turno_id]);
    const { rows: [actual] } = await client.query(
      'SELECT estado, documento, es_residente FROM colonia.inscripciones WHERE id = $1 FOR UPDATE',
      [inscripcionId],
    );
    if (actual?.estado === 'pendiente_de_validacion' && actual.es_residente === null
      && actual.documento === previa.documento) {
      await client.query(
        'UPDATE colonia.inscripciones SET es_residente = $2, padron_consultado_en = clock_timestamp() WHERE id = $1',
        [inscripcionId, residente],
      );
      await asignarTurno(previa.turno_id, client);
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    // Destruir la sesión revierte cualquier transacción abierta y libera su lock.
    // También cubre un timeout cuyo resultado SQL haya quedado incierto.
    descartar = true;
    throw error;
  } finally {
    if (adquirido && !descartar) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', [LOCK_INSCRIPCION, inscripcionId]);
      } catch {
        descartar = true;
      }
    }
    client.removeListener('error', conexionPerdida);
    client.release(descartar);
  }
}
