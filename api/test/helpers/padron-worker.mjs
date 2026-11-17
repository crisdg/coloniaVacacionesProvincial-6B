// Proceso independiente: pool propio y mismo PostgreSQL que las demás réplicas de prueba.
import { pool } from '../../src/db.js';
import { reservarConsulta } from '../../src/modules/inscripciones/padron-limite.js';
import { crearConsultaPadron } from '../../src/modules/inscripciones/padron-cliente.js';

process.send({ listo: true });
process.once('message', async ({ consultas = 0 }) => {
  try {
    if (!consultas) {
      process.send({ espera: await reservarConsulta() });
    } else {
      const instantes = [];
      const consultar = crearConsultaPadron({
        reservarConsulta,
        consultarResidencia: async () => {
          // hrtime usa el reloj monotónico del host, común a estos procesos.
          instantes.push(process.hrtime.bigint().toString());
          return true;
        },
      });
      for (let i = 0; i < consultas; i++) await consultar('91000001', 'Provincia');
      process.send({ instantes });
    }
  } catch (error) {
    process.send({ error: error.message });
    process.exitCode = 1;
  } finally {
    await pool.end();
    process.disconnect();
  }
});
