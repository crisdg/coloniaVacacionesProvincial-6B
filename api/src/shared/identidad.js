import { noAutenticado } from './problem.js';

// El gateway valida el token y reenvía la identidad en estos headers (ADR-007).
export function identidad(req, res, next) {
  const id = req.get('X-Usuario-Id');
  if (!id) throw noAutenticado('La API solo atiende pedidos que llegan por el gateway con un usuario autenticado.');
  req.usuario = {
    id,
    roles: (req.get('X-Usuario-Roles') ?? '').split(',').filter(Boolean),
  };
  next();
}

export const esAdministrador = (usuario) => usuario.roles.includes('administrador');
