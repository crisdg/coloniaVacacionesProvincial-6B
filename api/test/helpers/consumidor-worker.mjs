import { once } from 'node:events';
import { pool } from '../../src/db.js';
import { poolConsumidor, resolverInscripcion } from '../../src/modules/inscripciones/consumidor.js';

try {
  const resuelta = await resolverInscripcion(Number(process.argv[2]), async () => {
    process.send({ consultando: true });
    await once(process, 'message');
    return true;
  });
  process.send({ resuelta });
} catch (error) {
  process.send({ error: error.message });
  process.exitCode = 1;
} finally {
  await poolConsumidor.end();
  await pool.end();
  process.disconnect();
}
