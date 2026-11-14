// Gateway de autenticación y autorización (Clase 11).
// Se para DELANTE de la API: valida el token que emitió Keycloak y decide, según el rol,
// si el pedido pasa. La API de colonia no valida el token: solo el gateway.
import express from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const PORT = Number(process.env.PORT ?? 8000);
const API_URL = process.env.API_URL ?? 'http://localhost:3000';
// Las claves PÚBLICAS de Keycloak se buscan por la red interna (service discovery: "keycloak")...
const JWKS_URL = process.env.JWKS_URL ?? 'http://localhost:8180/realms/cursos/protocol/openid-connect/certs';
// ...pero el emisor (iss) del token es la URL que vio el NAVEGADOR al loguearse.
const ISSUER = process.env.ISSUER ?? 'http://localhost:8180/realms/cursos';
const AUDIENCE = process.env.AUDIENCE ?? 'api-cursos';
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:8080';

// Se descarga la primera vez que se valida un token y queda en caché.
// Por eso el gateway puede arrancar antes de que Keycloak esté listo.
const jwks = createRemoteJWKSet(new URL(JWKS_URL));

// ---------- Reglas de autorización (RBAC) ----------
// Quién puede hacer qué. Está en UN solo lugar y se lee como una tabla.
const REGLAS = [
  { metodo: 'GET',   ruta: /^\/health$/, roles: null },
  { metodo: 'GET',   ruta: /^\/turnos$/, roles: ['tutor', 'administrador'] },
  { metodo: 'POST',  ruta: /^\/turnos$/, roles: ['administrador'] },
  { metodo: 'GET',   ruta: /^\/turnos\/[^/]+$/, roles: ['tutor', 'administrador'] },
  { metodo: 'PATCH', ruta: /^\/turnos\/[^/]+$/, roles: ['administrador'] },
  { metodo: 'GET',   ruta: /^\/inscripciones$/, roles: ['tutor', 'administrador'] },
  { metodo: 'POST',  ruta: /^\/inscripciones$/, roles: ['tutor'] },
  { metodo: 'GET',   ruta: /^\/inscripciones\/[^/]+$/, roles: ['tutor', 'administrador'] },
  { metodo: 'PATCH', ruta: /^\/inscripciones\/[^/]+$/, roles: ['administrador'] },
  { metodo: 'POST',  ruta: /^\/inscripciones\/[^/]+\/cancelaciones$/, roles: ['administrador'] },
];

const app = express();
app.use(express.json());

// CORS: Swagger UI (localhost:8080) llama al gateway (localhost:8000) y manda el header Authorization
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Expose-Headers', 'Location, WWW-Authenticate');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function problem(res, status, title, detail, instance, headers = {}) {
  res.set(headers).status(status).type('application/problem+json').json({
    type: 'about:blank', title, status, detail, instance,
  });
}

// ---------- Autenticación: ¿quién sos? ----------
async function autenticar(req) {
  const auth = req.get('Authorization') ?? '';
  const [esquema, token] = auth.split(' ');
  if (esquema !== 'Bearer' || !token) return { error: 'Falta el header "Authorization: Bearer <token>".' };
  try {
    // Verifica la FIRMA con la clave pública de Keycloak, el emisor, la audiencia y el vencimiento.
    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: AUDIENCE });
    return { usuario: payload };
  } catch (err) {
    return { error: `Token inválido: ${err.code ?? ''} ${err.message}`.trim() };
  }
}

const rolesDe = (usuario) => usuario?.realm_access?.roles ?? [];

// ---------- /yo: muestra qué dice tu token (para aprender; no lo copies a sitios externos) ----------
app.get('/yo', async (req, res) => {
  const { usuario, error } = await autenticar(req);
  if (error) return problem(res, 401, 'No autenticado', error, req.originalUrl, { 'WWW-Authenticate': 'Bearer realm="cursos"' });
  res.json({
    usuario: usuario.preferred_username ?? `(cliente) ${usuario.azp}`,
    roles: rolesDe(usuario),
    emisor: usuario.iss,
    audiencia: usuario.aud,
    cliente: usuario.azp,
    venceEn: new Date(usuario.exp * 1000).toISOString(),
    tokenCompleto: usuario,
  });
});

// ---------- Todo lo demás: autenticar, autorizar y reenviar a la API ----------
app.use(async (req, res) => {
  const regla = REGLAS.find((r) => r.metodo === req.method && r.ruta.test(req.path));
  if (!regla) return problem(res, 404, 'No encontrado', `No hay ruta ${req.method} ${req.path} en el gateway.`, req.originalUrl);

  if (regla.roles) {
    const { usuario, error } = await autenticar(req);
    // 401: no sé quién sos
    if (error) return problem(res, 401, 'No autenticado', error, req.originalUrl, { 'WWW-Authenticate': 'Bearer realm="cursos"' });
    // 403: sé quién sos, pero tu rol no alcanza
    const roles = rolesDe(usuario);
    if (!regla.roles.some((r) => roles.includes(r))) {
      return problem(res, 403, 'Sin permiso',
        `${usuario.preferred_username ?? usuario.azp} tiene los roles [${roles.join(', ')}] y esta operación requiere uno de [${regla.roles.join(', ')}].`,
        req.originalUrl);
    }
  }

  try {
    const resp = await fetch(API_URL + req.originalUrl, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.stringify(req.body ?? {}) : undefined,
    });
    // Solo copiamos los headers que importan (el CORS lo maneja el gateway, no la API)
    for (const h of ['content-type', 'location']) if (resp.headers.get(h)) res.set(h, resp.headers.get(h));
    res.status(resp.status).send(Buffer.from(await resp.arrayBuffer()));
  } catch (err) {
    console.error(err.message);
    problem(res, 502, 'API no disponible', `El gateway no pudo comunicarse con ${API_URL}.`, req.originalUrl);
  }
});

app.listen(PORT, () => console.log(`Gateway en ${PORT} → API ${API_URL} · emisor esperado ${ISSUER}`));
