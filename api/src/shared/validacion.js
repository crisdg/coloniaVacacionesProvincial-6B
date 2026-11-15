import { invalido } from './problem.js';

const esObjeto = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);

// Aplica el esquema del contrato: campos conocidos (additionalProperties: false), obligatorios y mínimo de campos.
export function validarObjeto(valor, campos, { requeridos = [], minimo = 0, nombre = 'El cuerpo' } = {}) {
  if (!esObjeto(valor)) throw invalido(`${nombre} debe ser un objeto JSON.`);
  const desconocidos = Object.keys(valor).filter((clave) => !(clave in campos));
  if (desconocidos.length) throw invalido(`${nombre} tiene campos no permitidos: ${desconocidos.join(', ')}.`);
  const faltantes = requeridos.filter((clave) => valor[clave] === undefined);
  if (faltantes.length) throw invalido(`${nombre} no tiene los campos obligatorios: ${faltantes.join(', ')}.`);
  const presentes = Object.keys(valor);
  if (presentes.length < minimo) throw invalido(`${nombre} debe incluir al menos un campo.`);
  return Object.fromEntries(presentes.map((clave) => [clave, campos[clave](valor[clave], clave)]));
}

export function texto(valor, campo) {
  if (typeof valor !== 'string' || valor.trim() === '') throw invalido(`${campo} debe ser un texto no vacío.`);
  return valor.trim();
}

export function entero(minimo) {
  return (valor, campo) => {
    if (!Number.isInteger(valor) || valor < minimo || valor > 2147483647) {
      throw invalido(`${campo} debe ser un entero mayor o igual a ${minimo}.`);
    }
    return valor;
  };
}

export function fecha(valor, campo) {
  const valida = typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor)
    && new Date(`${valor}T00:00:00Z`).toISOString().slice(0, 10) === valor;
  if (!valida) throw invalido(`${campo} debe ser una fecha válida con formato AAAA-MM-DD.`);
  return valor;
}

export function fechaHora(valor, campo) {
  const valida = typeof valor === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(valor)
    && !Number.isNaN(Date.parse(valor));
  if (!valida) throw invalido(`${campo} debe ser fecha y hora con zona horaria, por ejemplo 2026-12-01T09:00:00-03:00.`);
  return new Date(valor).toISOString();
}

export function documento(valor, campo) {
  if (typeof valor !== 'string' || !/^[0-9]{7,8}$/.test(valor)) throw invalido(`${campo} debe ser un DNI de 7 u 8 dígitos, sin puntos.`);
  return valor;
}

export function idDeRuta(valor) {
  if (!/^[1-9][0-9]{0,9}$/.test(valor) || Number(valor) > 2147483647) {
    throw invalido('El identificador debe ser un entero positivo.');
  }
  return Number(valor);
}
