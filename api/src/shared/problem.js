export function problem(req, res, status, title, detail) {
  return res.status(status).type('application/problem+json').json({
    type: 'about:blank', title, status, detail, instance: req.originalUrl,
  });
}
export function pendiente(req, res) {
  return problem(req, res, 501, 'Funcionalidad pendiente',
    'Endpoint definido en OpenAPI. La lógica de negocio se implementará en la siguiente etapa.');
}
