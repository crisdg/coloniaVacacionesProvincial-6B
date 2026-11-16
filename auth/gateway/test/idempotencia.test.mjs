import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

test('el gateway permite la clave por CORS y la reenvía junto a la identidad verificada', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'prueba', alg: 'RS256' };
  const recibidos = [];
  const upstream = createServer(async (req, res) => {
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }));
    for await (const chunk of req) { /* Consumir el body antes de responder. */ }
    recibidos.push(req.headers);
    res.writeHead(202, { 'Content-Type': 'application/json', Location: 'inscripciones/123' });
    res.end(JSON.stringify({ id: 123, ordenRecepcion: 456 }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
  const gatewayURL = 'http://127.0.0.1:18001';
  const gateway = spawn(process.execPath, ['src/index.js'], {
    env: { ...process.env, PORT: '18001', API_URL: upstreamURL,
      JWKS_URL: `${upstreamURL}/jwks`, ISSUER: upstreamURL, AUDIENCE: 'api-colonia' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errores = '';
  gateway.stderr.on('data', data => { errores += data; });
  try {
    let disponible = false;
    let preflight;
    for (let i = 0; i < 100 && !disponible; i++) {
      if (gateway.exitCode !== null) assert.fail(errores);
      try {
        preflight = await fetch(`${gatewayURL}/inscripciones`, { method: 'OPTIONS' });
        disponible = preflight.status === 204;
      } catch {}
      if (!disponible) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(disponible, 'El gateway no arrancó.');
    assert.match(preflight.headers.get('access-control-allow-headers'), /Idempotency-Key/i);
    const token = await new SignJWT({ realm_access: { roles: ['tutor'] } })
      .setProtectedHeader({ alg: 'RS256', kid: 'prueba' }).setSubject('tutor-real')
      .setIssuer(upstreamURL).setAudience('api-colonia').setExpirationTime('2m').sign(privateKey);
    for (let i = 0; i < 2; i++) {
      const respuesta = await fetch(`${gatewayURL}/inscripciones`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
          'Idempotency-Key': 'solicitud-123', 'X-Usuario-Id': 'identidad-falsa' },
        body: JSON.stringify({ turnoId: 1 }),
      });
      assert.equal(respuesta.status, 202);
      assert.equal(respuesta.headers.get('location'), 'inscripciones/123');
      assert.deepEqual(await respuesta.json(), { id: 123, ordenRecepcion: 456 });
    }
    assert.equal(recibidos.length, 2);
    for (const headers of recibidos) {
      assert.equal(headers['idempotency-key'], 'solicitud-123');
      assert.equal(headers['x-usuario-id'], 'tutor-real');
      assert.equal(headers['x-usuario-roles'], 'tutor');
    }
  } finally {
    if (gateway.exitCode === null) {
      const cerrado = once(gateway, 'exit');
      gateway.kill();
      await cerrado;
    }
    await new Promise(resolve => upstream.close(resolve));
  }
});
