import express from 'express';
import { migrar, pool } from './db.js';
import turnos from './modules/inscripciones/turnos.routes.js';
import inscripciones from './modules/inscripciones/routes.js';
import { identidad } from './shared/identidad.js';
import { ErrorHttp, problem } from './shared/problem.js';

const app = express();
app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'ok', stage: 'esqueleto' });
  } catch {
    problem(req, res, 503, 'Servicio no disponible', 'No se pudo comprobar la conexión con PostgreSQL.');
  }
});
app.use('/turnos', identidad, turnos);
app.use('/inscripciones', identidad, inscripciones);
app.use((req, res) => problem(req, res, 404, 'No encontrado', 'La ruta no existe.'));
app.use((err, req, res, next) => {
  if (err instanceof ErrorHttp) return problem(req, res, err.status, err.title, err.message);
  if (err.type === 'entity.parse.failed') {
    return problem(req, res, 400, 'JSON inválido', 'El cuerpo debe contener JSON válido.');
  }
  console.error(err);
  problem(req, res, 500, 'Error interno', 'Ocurrió un error inesperado.');
});

await migrar();
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`API de Colonia de Vacaciones escuchando en ${port}`));
