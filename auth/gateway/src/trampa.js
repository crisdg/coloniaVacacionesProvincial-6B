// Experimento: ¿qué pasa si edito mi token para darme el rol "docente"?
// Uso (dentro del contenedor del gateway):  node src/trampa.js <tu_access_token>
const token = process.argv[2];
if (!token || token.split('.').length !== 3) {
  console.error('Pasame un access token como argumento: node src/trampa.js eyJ...');
  process.exit(1);
}
const [header, payload, firma] = token.split('.');

// Un JWT NO está cifrado: el payload es JSON en Base64URL. Cualquiera lo lee... y lo puede cambiar.
const datos = JSON.parse(Buffer.from(payload, 'base64url').toString());
console.log('Roles originales:', datos.realm_access?.roles);
datos.realm_access = { roles: ['docente'] };
const payloadTrucho = Buffer.from(JSON.stringify(datos)).toString('base64url');
const tokenTrucho = `${header}.${payloadTrucho}.${firma}`;   // misma firma, contenido distinto
console.log('Roles en el token editado:', datos.realm_access.roles);

const resp = await fetch('http://localhost:8000/turnos', {
  method: 'POST',
  headers: { Authorization: `Bearer ${tokenTrucho}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ nombre: 'Turno trucho', cupo: 1 }),
});
console.log(`POST /turnos con el token editado → ${resp.status}`);
console.log(await resp.text());
