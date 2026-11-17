import { enTransaccion } from '../../db.js';

// Una transacción por mensaje: otras réplicas omiten esta fila mientras espera
// el confirm del broker. Un fallo no revierte los mensajes anteriores del lote.
// publicar debe resolver solo con confirm y tener un timeout acotado.
export async function publicarLoteSalida(publicar, { maximo = 20 } = {}) {
  let publicados = 0;
  for (let i = 0; i < maximo; i++) {
    const publicado = await enTransaccion(async (client) => {
      const { rows: [fila] } = await client.query(
        `SELECT id, inscripcion_id FROM colonia.salida
         WHERE publicado_en IS NULL ORDER BY id LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      if (!fila) return false;
      await publicar(fila.inscripcion_id);
      await client.query(
        'UPDATE colonia.salida SET publicado_en = clock_timestamp() WHERE id = $1',
        [fila.id],
      );
      return true;
    });
    if (!publicado) break;
    publicados++;
  }
  return publicados;
}
