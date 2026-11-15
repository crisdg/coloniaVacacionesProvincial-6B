const ZONA = 'America/Argentina/Buenos_Aires';
// Argentina no usa horario de verano desde 2009: el inicio del día es siempre a las 00:00 -03:00.
const DESFASE_ARGENTINA = '-03:00';

const formatoFecha = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' });

export const fechaEnArgentina = (instante) => formatoFecha.format(instante);

export const inicioDelDia = (fecha) => new Date(`${fecha}T00:00:00${DESFASE_ARGENTINA}`);

export function edadEn(fechaNacimiento, fechaReferencia) {
  const [anioNac, mesNac, diaNac] = fechaNacimiento.split('-').map(Number);
  const [anio, mes, dia] = fechaReferencia.split('-').map(Number);
  const cumplioEsteAnio = mes > mesNac || (mes === mesNac && dia >= diaNac);
  return anio - anioNac - (cumplioEsteAnio ? 0 : 1);
}
