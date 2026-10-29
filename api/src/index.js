import express from 'express';
import pg from 'pg';
import turnos from './modules/inscripciones/turnos.routes.js';
import inscripciones from './modules/inscripciones/routes.js';
import { problem } from './shared/problem.js';

for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
  if (!process.env[key]) throw new Error(`Falta la variable de entorno ${key}`);
}
const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionTimeoutMillis: 3000,
  query_timeout: 3000,
});
pool.on('error', (error) => console.error('Error en conexión inactiva a PostgreSQL:', error.message));
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
app.use('/turnos', turnos);
app.use('/inscripciones', inscripciones);
app.use((req, res) => problem(req, res, 404, 'No encontrado', 'La ruta no existe.'));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return problem(req, res, 400, 'JSON inválido', 'El cuerpo debe contener JSON válido.');
  }
  console.error(err);
  problem(req, res, 500, 'Error interno', 'Ocurrió un error inesperado.');
});
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`API de Colonia de Vacaciones escuchando en ${port}`));
