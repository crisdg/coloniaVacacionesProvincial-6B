import { Router } from 'express';
import { enTransaccion, pool } from '../../db.js';
import { edadEn, fechaEnArgentina } from '../../shared/fechas.js';
import { esAdministrador } from '../../shared/identidad.js';
import { conflicto, invalido, noEncontrado, pendiente } from '../../shared/problem.js';
import { documento, entero, fecha, idDeRuta, texto, validarObjeto } from '../../shared/validacion.js';

const EDAD_MINIMA = 6;
const EDAD_MAXIMA = 12;
const ESTADOS_FINALES = ['rechazada', 'cancelada'];

const CAMPOS_CHICO = { documento, nombre: texto, apellido: texto, fechaNacimiento: fecha };
const validarChico = (valor) => validarObjeto(valor, CAMPOS_CHICO, { requeridos: Object.keys(CAMPOS_CHICO), nombre: 'chico' });
const validarCorreccionChico = (valor) => validarObjeto(valor, CAMPOS_CHICO, { minimo: 1, nombre: 'chico' });

const aInscripcion = (fila) => ({
  id: fila.id,
  turnoId: fila.turno_id,
  chico: {
    documento: fila.documento,
    nombre: fila.nombre,
    apellido: fila.apellido,
    fechaNacimiento: fila.fecha_nacimiento,
  },
  estado: fila.estado,
  ordenRecepcion: Number(fila.orden_recepcion),
  creadoEn: fila.creado_en.toISOString(),
  ...(fila.motivo_rechazo && { motivoRechazo: fila.motivo_rechazo }),
  ...(fila.motivo_cancelacion && { motivoCancelacion: fila.motivo_cancelacion }),
});

function validarEdad(fechaNacimiento, fechaReferencia) {
  const edad = edadEn(fechaNacimiento, fechaReferencia);
  if (edad < EDAD_MINIMA || edad > EDAD_MAXIMA) {
    throw invalido(`El chico debe tener de ${EDAD_MINIMA} a ${EDAD_MAXIMA} años al ${fechaReferencia}; tiene ${edad}.`);
  }
}

const esInscripcionActivaDuplicada = (error) => error.code === '23505' && error.constraint === 'inscripcion_activa_por_dni';
const DUPLICADA = 'El chico ya tiene una inscripción activa en esta convocatoria.';

// Un tutor solo ve las propias: la ajena responde 404 para no revelar que existe.
async function buscarAccesible(id, usuario, db = pool, { bloquear = false } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM colonia.inscripciones WHERE id = $1${bloquear ? ' FOR UPDATE' : ''}`,
    [id],
  );
  const fila = rows[0];
  if (!fila || (!esAdministrador(usuario) && fila.tutor_id !== usuario.id)) {
    throw noEncontrado(`No existe la inscripción ${id}.`);
  }
  return fila;
}

const router = Router();

router.post('/', async (req, res) => {
  const { turnoId, chico } = validarObjeto(
    req.body,
    { turnoId: entero(1), chico: validarChico },
    { requeridos: ['turnoId', 'chico'] },
  );
  const { rows: turnos } = await pool.query(
    'SELECT convocatoria_id, inscripcion_abre_en, inscripcion_cierra_en FROM colonia.turnos WHERE id = $1',
    [turnoId],
  );
  const turno = turnos[0];
  if (!turno) throw noEncontrado(`No existe el turno ${turnoId}.`);
  const recibidaEn = new Date();
  if (recibidaEn < turno.inscripcion_abre_en || recibidaEn >= turno.inscripcion_cierra_en) {
    throw conflicto('El período de inscripción del turno no está abierto.');
  }
  validarEdad(chico.fechaNacimiento, fechaEnArgentina(recibidaEn));
  try {
    const { rows } = await pool.query(
      `INSERT INTO colonia.inscripciones
         (turno_id, convocatoria_id, tutor_id, documento, nombre, apellido, fecha_nacimiento, creado_en)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [turnoId, turno.convocatoria_id, req.usuario.id, chico.documento, chico.nombre, chico.apellido,
        chico.fechaNacimiento, recibidaEn],
    );
    const inscripcion = aInscripcion(rows[0]);
    res.status(202).location(`inscripciones/${inscripcion.id}`).json(inscripcion);
  } catch (error) {
    if (esInscripcionActivaDuplicada(error)) throw conflicto(DUPLICADA);
    throw error;
  }
});

router.get('/', async (req, res) => {
  const { rows } = esAdministrador(req.usuario)
    ? await pool.query('SELECT * FROM colonia.inscripciones ORDER BY orden_recepcion')
    : await pool.query('SELECT * FROM colonia.inscripciones WHERE tutor_id = $1 ORDER BY orden_recepcion', [req.usuario.id]);
  res.json(rows.map(aInscripcion));
});

router.get('/:id', async (req, res) => {
  res.json(aInscripcion(await buscarAccesible(idDeRuta(req.params.id), req.usuario)));
});

router.patch('/:id', async (req, res) => {
  const id = idDeRuta(req.params.id);
  const { chico } = validarObjeto(req.body, { chico: validarCorreccionChico }, { requeridos: ['chico'] });
  const fila = await enTransaccion(async (client) => {
    const actual = await buscarAccesible(id, req.usuario, client, { bloquear: true });
    if (ESTADOS_FINALES.includes(actual.estado)) {
      throw conflicto(`No se puede corregir una inscripción ${actual.estado}.`);
    }
    if (chico.documento !== undefined && chico.documento !== actual.documento) {
      throw pendiente('Corregir el DNI requiere validar la residencia con el padrón, que todavía no está implementado.');
    }
    const nuevo = {
      nombre: chico.nombre ?? actual.nombre,
      apellido: chico.apellido ?? actual.apellido,
      fechaNacimiento: chico.fechaNacimiento ?? actual.fecha_nacimiento,
    };
    validarEdad(nuevo.fechaNacimiento, fechaEnArgentina(actual.creado_en));
    const { rows } = await client.query(
      `UPDATE colonia.inscripciones SET nombre = $2, apellido = $3, fecha_nacimiento = $4
       WHERE id = $1 RETURNING *`,
      [id, nuevo.nombre, nuevo.apellido, nuevo.fechaNacimiento],
    );
    return rows[0];
  });
  res.json(aInscripcion(fila));
});

router.post('/:id/cancelaciones', async (req, res) => {
  const id = idDeRuta(req.params.id);
  const { motivo } = validarObjeto(req.body, { motivo: texto }, { requeridos: ['motivo'] });
  const fila = await enTransaccion(async (client) => {
    const actual = await buscarAccesible(id, req.usuario, client, { bloquear: true });
    if (ESTADOS_FINALES.includes(actual.estado)) {
      throw conflicto(`La inscripción ya está ${actual.estado}.`);
    }
    const { rows } = await client.query(
      `UPDATE colonia.inscripciones SET estado = 'cancelada', motivo_cancelacion = $2
       WHERE id = $1 RETURNING *`,
      [id, motivo],
    );
    return rows[0];
  });
  res.json(aInscripcion(fila));
});

export default router;
