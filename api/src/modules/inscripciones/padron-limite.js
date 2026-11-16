import { enTransaccion } from '../../db.js';

function topePorSegundo() {
  const valor = Number(process.env.PADRON_CONSULTAS_POR_SEGUNDO ?? 50);
  return Number.isInteger(valor) && valor > 0 ? valor : 50;
}

// Regulador actual por segundos fijos. La ventana móvil corresponde al paso 5.
// Devuelve 0 si obtuvo permiso, o los milisegundos hasta el próximo segundo.
export async function reservarConsulta() {
  const tope = topePorSegundo();
  return enTransaccion(async (client) => {
    const reserva = await client.query(
      `INSERT INTO colonia.consultas_padron (segundo, cantidad)
       VALUES (date_trunc('second', clock_timestamp()), 1)
       ON CONFLICT (segundo) DO UPDATE
         SET cantidad = colonia.consultas_padron.cantidad + 1
         WHERE colonia.consultas_padron.cantidad < $1
       RETURNING cantidad`,
      [tope],
    );
    if (reserva.rows.length) {
      await client.query(
        `DELETE FROM colonia.consultas_padron WHERE segundo < clock_timestamp() - interval '2 minutes'`,
      );
      return 0;
    }
    const { rows } = await client.query(
      `SELECT ceil(extract(epoch FROM (
         date_trunc('second', clock_timestamp()) + interval '1 second' - clock_timestamp()
       )) * 1000)::int AS espera`,
    );
    return Math.max(rows[0].espera, 1);
  });
}
