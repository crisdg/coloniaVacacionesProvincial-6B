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
    informarSesion();
    mostrarSesion();
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

function mostrarError(mensaje) {
  const elemento = $('#auth-message');
  elemento.hidden = !mensaje;
  elemento.textContent = mensaje;
}

async function mostrarSesion() {
  const ingresarBtn = $('#ingresar');
  const salirBtn = $('#salir');

  if (!token()) {
    $('#sesion').textContent = 'Ingresá para acceder a tu espacio.';
    if (ingresarBtn) ingresarBtn.hidden = false;
    if (salirBtn) salirBtn.hidden = true;
    informarSesion();
    return;
  }
  
  if (ingresarBtn) ingresarBtn.hidden = true;
  if (salirBtn) salirBtn.hidden = false;

  const response = await fetch('http://localhost:8000/yo', { headers: { Authorization: `Bearer ${token()}` } });
  if (response.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    informarSesion();
    await mostrarSesion();
    return;
  }
  if (!response.ok) {
    informarSesion();
    $('#sesion').textContent = 'No se pudo cargar tu espacio en este momento.';
    mostrarError('Intentá nuevamente más tarde.');
    return;
  }

  const yo = await response.json();
  const roles = yo.roles ?? [];
  informarSesion(roles);
  mostrarError('');
  $('#sesion').textContent = `Hola, ${yo.usuario}.`;
}

document.addEventListener('DOMContentLoaded', async () => {
  $('#ingresar').addEventListener('click', () => {
    ingresar().catch(() => mostrarError('No se pudo iniciar sesión. Intentá nuevamente.'));
  });
  $('#salir').addEventListener('click', salir);

  try {
    await completarLogin();
  } catch (error) {
    mostrarError('No se pudo completar el inicio de sesión. Intentá nuevamente.');
    history.replaceState({}, '', REDIRECT_URI);
  }
  try {
    await mostrarSesion();
  } catch {
    mostrarError('No se pudo cargar tu espacio en este momento.');
  }

  fetch('/api/health')
    .then((response) => { if (!response.ok) throw new Error(); return response.json(); })
    .then(() => { $('#estado').textContent = 'El sistema está disponible.'; })
    .catch(() => { $('#estado').textContent = 'El sistema no está disponible en este momento.'; });
});