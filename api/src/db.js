import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
  if (!process.env[key]) throw new Error(`Falta la variable de entorno ${key}`);
}

// Las columnas date se devuelven tal cual (YYYY-MM-DD), sin pasar por la zona horaria del proceso.
pg.types.setTypeParser(pg.types.builtins.DATE, (valor) => valor);

export function crearPool() {
  const nuevo = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
    max: 10,
  });
  nuevo.on('error', (error) => console.error('Error en conexión inactiva a PostgreSQL:', error.message));
  return nuevo;
}

export const pool = crearPool();

export async function enTransaccion(trabajo) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await trabajo(client);
    await client.query('COMMIT');
    return resultado;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Varias réplicas de la API pueden arrancar a la vez: el lock evita aplicar dos veces la misma migración.
const LOCK_MIGRACIONES = 727001;

export async function migrar() {
  const directorio = new URL('../migrations/', import.meta.url);
  const archivos = (await readdir(directorio)).filter((archivo) => archivo.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_MIGRACIONES]);
    await client.query('CREATE SCHEMA IF NOT EXISTS colonia');
    await client.query(`CREATE TABLE IF NOT EXISTS colonia.migraciones (
      nombre text PRIMARY KEY,
      aplicada_en timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT nombre FROM colonia.migraciones');
    const aplicadas = new Set(rows.map((fila) => fila.nombre));
    for (const archivo of archivos) {
      if (aplicadas.has(archivo)) continue;
      const sql = await readFile(new URL(archivo, directorio), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO colonia.migraciones (nombre) VALUES ($1)', [archivo]);
        await client.query('COMMIT');
        console.log(`Migración aplicada: ${archivo}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_MIGRACIONES]).catch(() => {});
    client.release();
  }
}
