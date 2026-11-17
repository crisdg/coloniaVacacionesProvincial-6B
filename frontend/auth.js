const ISSUER = 'http://localhost:8180/realms/colonia';
const CLIENT_ID = 'frontend';
const REDIRECT_URI = 'http://localhost:3001/';
const TOKEN_KEY = 'colonia.access_token';
const ID_TOKEN_KEY = 'colonia.id_token';

const $ = (id) => document.querySelector(id);

function base64url(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function randomString() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function token() {
  return sessionStorage.getItem(TOKEN_KEY);
}

function informarSesion(roles = []) {
  sessionStorage.setItem('colonia.is_tutor', roles.includes('tutor') ? 'true' : 'false');
  document.dispatchEvent(new CustomEvent('colonia:session', { detail: { roles } }));
}

async function ingresar() {
  const verifier = randomString();
  const state = randomString();
  sessionStorage.setItem('colonia.pkce_verifier', verifier);
  sessionStorage.setItem('colonia.pkce_state', state);
  const url = new URL(`${ISSUER}/protocol/openid-connect/auth`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', 'openid profile');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await codeChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  location.assign(url);
}

function salir() {
  const idToken = sessionStorage.getItem(ID_TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(ID_TOKEN_KEY);
  sessionStorage.removeItem('colonia.pkce_verifier');
  sessionStorage.removeItem('colonia.pkce_state');
  if (!idToken) {
    mostrarSesion();
    $('#resultado').textContent = 'Sesión cerrada en esta página.';
    return;
  }
  const url = new URL(`${ISSUER}/protocol/openid-connect/logout`);
  url.searchParams.set('id_token_hint', idToken);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('post_logout_redirect_uri', REDIRECT_URI);
  location.assign(url);
}

async function completarLogin() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return;
  const state = params.get('state');
  if (!state || state !== sessionStorage.getItem('colonia.pkce_state')) {
    throw new Error('La respuesta de login no coincide con el pedido iniciado en esta página.');
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: sessionStorage.getItem('colonia.pkce_verifier') ?? '',
  });
  const response = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || 'Keycloak rechazó el canje del código.');
  }
  sessionStorage.setItem(TOKEN_KEY, payload.access_token);
  if (payload.id_token) sessionStorage.setItem(ID_TOKEN_KEY, payload.id_token);
  sessionStorage.removeItem('colonia.pkce_verifier');
  sessionStorage.removeItem('colonia.pkce_state');
  history.replaceState({}, '', REDIRECT_URI);
}

async function llamar(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  
  const response = await fetch(`http://localhost:8000${path}`, { ...options, headers });
  const texto = await response.text();
  let cuerpo = texto;
  try { cuerpo = JSON.stringify(JSON.parse(texto), null, 2); } catch { /* texto plano */ }
  
  const resBox = $('#resultado');
  resBox.style.display = 'block';
  resBox.className = response.ok 
    ? "mt-4 rounded-xl border border-emerald-200 bg-emerald-50/50 p-4 font-mono text-xs text-emerald-900 overflow-x-auto shadow-sm"
    : "mt-4 rounded-xl border border-red-200 bg-red-50 p-4 font-mono text-xs text-red-900 overflow-x-auto shadow-sm";
  
  resBox.textContent = `Status: ${response.status} ${response.statusText}\n\n${cuerpo}`;
  return response;
}

async function mostrarSesion() {
  const ingresarBtn = $('#ingresar');
  const salirBtn = $('#salir');
  const acciones = $('#acciones');
  const crearTurnoBtn = $('#crear');
  const resBox = $('#resultado');

  if (!token()) {
    $('#sesion').textContent = 'Sin sesión. Ingresá con ana (administrador) o beto (tutor).';
    if (ingresarBtn) ingresarBtn.hidden = false;
    if (salirBtn) salirBtn.hidden = true;
    if (acciones) acciones.hidden = true;
    if (resBox) resBox.style.display = 'block';
    informarSesion();
    return;
  }
  
  if (ingresarBtn) ingresarBtn.hidden = true;
  if (salirBtn) salirBtn.hidden = false;

  const response = await fetch('http://localhost:8000/yo', { headers: { Authorization: `Bearer ${token()}` } });
  if (response.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    mostrarSesion();
    return;
  }
  const yo = await response.json();
  const roles = response.ok ? yo.roles ?? [] : [];
  informarSesion(roles);
  
  const esAdmin = roles.includes('administrador');
  const esTutor = roles.includes('tutor');

  // Usamos .hidden en lugar de style.display para respetar el atributo HTML
  if (acciones) {
    acciones.hidden = !esAdmin; // Visible solo para admin
  }
  
  if (crearTurnoBtn) {
    crearTurnoBtn.hidden = !esAdmin; // Visible solo para admin
  }
  
  if (resBox && esTutor && !esAdmin) {
    resBox.style.display = 'none'; // Oculto para tutor
  } else if (resBox) {
    resBox.style.display = 'block';
  }

  $('#sesion').textContent = response.ok
    ? `Sesión de ${yo.usuario}. Roles: ${roles.filter((rol) => rol === 'tutor' || rol === 'administrador').join(', ') || 'ninguno de colonia'}.`
    : 'No se pudo leer la sesión.';
}

async function listarTurnos() {
  await llamar('/turnos');
}

async function crearTurno() {
  const dentroDeDias = (dias) => new Date(Date.now() + dias * 86_400_000);
  await llamar('/turnos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      convocatoriaId: 'verano-2027',
      sedeId: 1,
      nombre: 'Turno mañana',
      fechaInicio: dentroDeDias(30).toISOString().slice(0, 10),
      fechaFin: dentroDeDias(50).toISOString().slice(0, 10),
      inscripcionAbreEn: new Date().toISOString(),
      inscripcionCierraEn: dentroDeDias(20).toISOString(),
      cupoTotal: 30,
    }),
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  $('#ingresar').addEventListener('click', () => { ingresar().catch((error) => { $('#resultado').textContent = error.message; }); });
  $('#salir').addEventListener('click', salir);
  $('#listar').addEventListener('click', () => { listarTurnos().catch((error) => { $('#resultado').textContent = error.message; }); });
  $('#crear').addEventListener('click', () => { crearTurno().catch((error) => { $('#resultado').textContent = error.message; }); });

  const resBox = $('#resultado');
  if (resBox) resBox.style.display = 'none';

  try {
    await completarLogin();
  } catch (error) {
    $('#resultado').style.display = 'block';
    $('#resultado').textContent = error.message;
    history.replaceState({}, '', REDIRECT_URI);
  }
  await mostrarSesion();

  fetch('/api/health')
    .then((response) => { if (!response.ok) throw new Error(); return response.json(); })
    .then(() => { $('#estado').textContent = 'API y base de datos disponibles.'; })
    .catch(() => { $('#estado').textContent = 'No se pudo comprobar la disponibilidad del sistema.'; });
});