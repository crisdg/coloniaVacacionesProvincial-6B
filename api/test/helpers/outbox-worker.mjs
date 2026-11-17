// Réplica con pool propio: mantiene el evento en vuelo hasta que la prueba la termina.
import { publicarLoteSalida } from '../../src/modules/inscripciones/outbox.js';

await publicarLoteSalida(async inscripcionId => {
  process.send({ reclamada: inscripcionId });
  await new Promise(() => {});
}, { maximo: 1 });
