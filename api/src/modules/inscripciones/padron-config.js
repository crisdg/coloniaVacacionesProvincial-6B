export const VENTANA_PADRON_MS = 1000;
// El cliente descarta permisos que tardan demasiado en llegar. Se retienen estos
// 100 ms adicionales en BD para cubrir el desfase entre concesión e inicio real.
export const VIGENCIA_PERMISO_MS = 100;

export function leerTopePadron(valor = process.env.PADRON_CONSULTAS_POR_SEGUNDO ?? '50') {
  const tope = Number(valor);
  if (!Number.isInteger(tope) || tope < 1 || tope > 50) {
    throw new Error('PADRON_CONSULTAS_POR_SEGUNDO debe ser un entero entre 1 y 50.');
  }
  return tope;
}
