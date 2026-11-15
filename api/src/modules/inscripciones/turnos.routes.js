import { Router } from 'express';
import { enTransaccion, pool } from '../../db.js';
import { inicioDelDia } from '../../shared/fechas.js';
import { conflicto, invalido, noEncontrado } from '../../shared/problem.js';
import { asignarTurno } from './asignacion.js';
import { entero, fecha, fechaHora, idDeRuta, texto, validarObjeto } from '../../shared/validacion.js';

const CAMPOS_EDITABLES = {
  nombre: texto,
  fechaInicio: fecha,
  fechaFin: fecha,
  inscripcionAbreEn: fechaHora,
  inscripcionCierraEn: fechaHora,
  cupoTotal: entero(0),
};
const CAMPOS_NUEVO = { convocatoriaId: texto, sedeId: entero(1), ...CAMPOS_EDITABLES };

const SELECT_TURNO = `
  SELECT t.id, t.convocatoria_id, t.sede_id, t.nombre, t.fecha_inicio, t.fecha_fin,
         t.inscripcion_abre_en, t.inscripcion_cierra_en, t.cupo_total,
         count(i.id) FILTER (WHERE i.estado = 'confirmada')::int AS confirmados,
         count(i.id) FILTER (WHERE i.estado = 'en_lista_de_espera')::int AS en_espera
  FROM colonia.turnos t
  LEFT JOIN colonia.inscripciones i ON i.turno_id = t.id`;

const aTurno = (fila) => ({
  id: fila.id,
  convocatoriaId: fila.convocatoria_id,
  sedeId: fila.sede_id,
  nombre: fila.nombre,
  fechaInicio: fila.fecha_inicio,
  fechaFin: fila.fecha_fin,
  inscripcionAbreEn: fila.inscripcion_abre_en.toISOString(),
  inscripcionCierraEn: fila.inscripcion_cierra_en.toISOString(),
  cupoTotal: fila.cupo_total,
  confirmados: fila.confirmados,
  disponibles: Math.max(fila.cupo_total - fila.confirmados, 0),
  enEspera: fila.en_espera,
});

async function buscarTurno(id, db = pool) {
  const { rows } = await db.query(`${SELECT_TURNO} WHERE t.id = $1 GROUP BY t.id`, [id]);
  if (!rows.length) throw noEncontrado(`No existe el turno ${id}.`);
  return aTurno(rows[0]);
}

function validarFechas(turno) {
  if (turno.fechaInicio > turno.fechaFin) {
    throw invalido('fechaInicio no puede ser posterior a fechaFin.');
  }
  if (new Date(turno.inscripcionAbreEn) >= new Date(turno.inscripcionCierraEn)) {
    throw invalido('inscripcionAbreEn debe ser anterior a inscripcionCierraEn.');
  }
  if (new Date(turno.inscripcionCierraEn) > inicioDelDia(turno.fechaInicio)) {
    throw invalido('inscripcionCierraEn no puede ser posterior al inicio de la actividad (fechaInicio).');
  }
}

const router = Router();

router.get('/', async (req, res) => {
  const { rows } = await pool.query(`${SELECT_TURNO} GROUP BY t.id ORDER BY t.fecha_inicio, t.id`);
  res.json(rows.map(aTurno));
});

router.post('/', async (req, res) => {
  const turno = validarObjeto(req.body, CAMPOS_NUEVO, { requeridos: Object.keys(CAMPOS_NUEVO) });
  validarFechas(turno);
  const catalogo = await pool.query(
    `SELECT (SELECT count(*) FROM colonia.convocatorias WHERE id = $1)::int AS convocatorias,
            (SELECT count(*) FROM colonia.sedes WHERE id = $2)::int AS sedes`,
    [turno.convocatoriaId, turno.sedeId],
  );
  if (!catalogo.rows[0].convocatorias) throw invalido(`La convocatoria ${turno.convocatoriaId} no existe.`);
  if (!catalogo.rows[0].sedes) throw invalido(`La sede ${turno.sedeId} no existe.`);
  const { rows } = await pool.query(
    `INSERT INTO colonia.turnos
       (convocatoria_id, sede_id, nombre, fecha_inicio, fecha_fin, inscripcion_abre_en, inscripcion_cierra_en, cupo_total)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [turno.convocatoriaId, turno.sedeId, turno.nombre, turno.fechaInicio, turno.fechaFin,
      turno.inscripcionAbreEn, turno.inscripcionCierraEn, turno.cupoTotal],
  );
  const creado = await buscarTurno(rows[0].id);
  res.status(201).location(`turnos/${creado.id}`).json(creado);
});

router.get('/:id', async (req, res) => {
  res.json(await buscarTurno(idDeRuta(req.params.id)));
});

router.patch('/:id', async (req, res) => {
  const id = idDeRuta(req.params.id);
  const cambios = validarObjeto(req.body, CAMPOS_EDITABLES, { minimo: 1 });
  const turno = await enTransaccion(async (client) => {
    // El lock serializa los cambios de cupo con las asignaciones del mismo turno.
    const bloqueado = await client.query('SELECT id FROM colonia.turnos WHERE id = $1 FOR UPDATE', [id]);
    if (!bloqueado.rows.length) throw noEncontrado(`No existe el turno ${id}.`);
    const actual = await buscarTurno(id, client);
    const combinado = { ...actual, ...cambios };
    validarFechas(combinado);
    if (combinado.cupoTotal < actual.confirmados) {
      throw conflicto(`El cupo no puede ser menor que las ${actual.confirmados} inscripciones confirmadas.`);
    }
    await client.query(
      `UPDATE colonia.turnos
       SET nombre = $2, fecha_inicio = $3, fecha_fin = $4, inscripcion_abre_en = $5,
           inscripcion_cierra_en = $6, cupo_total = $7
       WHERE id = $1`,
      [id, combinado.nombre, combinado.fechaInicio, combinado.fechaFin,
        combinado.inscripcionAbreEn, combinado.inscripcionCierraEn, combinado.cupoTotal],
    );
    if (combinado.cupoTotal > actual.cupoTotal) await asignarTurno(id, client);
    return buscarTurno(id, client);
  });
  res.json(turno);
});

export default router;
