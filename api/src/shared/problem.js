export function problem(req, res, status, title, detail) {
  return res.status(status).type('application/problem+json').json({
    type: 'about:blank', title, status, detail, instance: req.originalUrl,
  });
}

export class ErrorHttp extends Error {
  constructor(status, title, detail) {
    super(detail);
    this.status = status;
    this.title = title;
  }
}

export const invalido = (detail) => new ErrorHttp(400, 'Datos inválidos', detail);
export const noAutenticado = (detail) => new ErrorHttp(401, 'No autenticado', detail);
export const noEncontrado = (detail) => new ErrorHttp(404, 'No encontrado', detail);
export const conflicto = (detail) => new ErrorHttp(409, 'Conflicto', detail);
export const pendiente = (detail) => new ErrorHttp(501, 'Funcionalidad pendiente', detail);
