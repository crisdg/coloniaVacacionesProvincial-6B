import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const raiz = fileURLToPath(new URL('../', import.meta.url));
const extensiones = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'];

async function archivosEn(directorio) {
  const entradas = await readdir(directorio, { withFileTypes: true });
  const encontrados = await Promise.all(entradas.map(async (entrada) => {
    const ruta = path.join(directorio, entrada.name);
    if (entrada.isDirectory()) return archivosEn(ruta);
    return extensiones.includes(path.extname(entrada.name)) ? [ruta] : [];
  }));
  return encontrados.flat();
}

async function importaciones(archivo) {
  const contenido = await readFile(archivo, 'utf8');
  const especificadores = [];
  const expresion = /^\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|^\s*import\s*\(\s*['"]([^'"]+)['"]/gm;
  for (const coincidencia of contenido.matchAll(expresion)) {
    especificadores.push(coincidencia[1] ?? coincidencia[2]);
  }
  return especificadores;
}

async function importsLocales(archivo) {
  return (await importaciones(archivo)).filter((especificador) => especificador.startsWith('.'));
}

async function resolverImport(archivo, especificador) {
  const base = path.resolve(path.dirname(archivo), especificador);
  const candidatos = [base, ...extensiones.map((extension) => base + extension),
    ...extensiones.map((extension) => path.join(base, `index${extension}`))];
  for (const candidato of candidatos) {
    try {
      const info = await stat(candidato);
      if (info.isFile()) return candidato;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  return undefined;
}

async function grafoDe(archivos) {
  const incluidos = new Set(archivos);
  const grafo = new Map();
  for (const archivo of archivos) {
    const destinos = [];
    for (const especificador of await importsLocales(archivo)) {
      const destino = await resolverImport(archivo, especificador);
      if (destino && incluidos.has(destino)) destinos.push(destino);
    }
    grafo.set(archivo, destinos);
  }
  return grafo;
}

function encontrarCiclos(grafo) {
  const visitados = new Set();
  const activos = new Set();
  const ruta = [];
  const ciclos = [];
  function visitar(archivo) {
    if (activos.has(archivo)) {
      const inicio = ruta.indexOf(archivo);
      ciclos.push([...ruta.slice(inicio), archivo]);
      return;
    }
    if (visitados.has(archivo)) return;
    activos.add(archivo);
    ruta.push(archivo);
    for (const destino of grafo.get(archivo) ?? []) visitar(destino);
    ruta.pop();
    activos.delete(archivo);
    visitados.add(archivo);
  }
  for (const archivo of grafo.keys()) visitar(archivo);
  return ciclos;
}

const rutaRelativa = (archivo) => path.relative(raiz, archivo).split(path.sep).join('/');

test('los grafos de dependencias locales del API, gateway y frontend no tienen ciclos', async () => {
  const [api, gateway, frontendSrc] = await Promise.all([
    archivosEn(path.join(raiz, 'api/src')),
    archivosEn(path.join(raiz, 'auth/gateway/src')),
    archivosEn(path.join(raiz, 'frontend/src')),
  ]);
  const frontend = [path.join(raiz, 'frontend/auth.js'), ...frontendSrc];
  const grafos = await Promise.all([api, gateway, frontend].map(grafoDe));

  const ciclos = grafos.flatMap((grafo) => encontrarCiclos(grafo));
  assert.deepEqual(ciclos.map((ciclo) => ciclo.map(rutaRelativa)), [], 'Se encontraron ciclos de imports locales.');
});

test('los módulos compartidos del API no dependen de modules', async () => {
  const shared = path.join(raiz, 'api/src/shared');
  const modules = path.join(raiz, 'api/src/modules') + path.sep;
  const archivos = await archivosEn(shared);
  const dependencias = [];
  for (const archivo of archivos) {
    for (const especificador of await importsLocales(archivo)) {
      const destino = await resolverImport(archivo, especificador);
      if (destino?.startsWith(modules)) dependencias.push(`${rutaRelativa(archivo)} -> ${rutaRelativa(destino)}`);
    }
  }
  assert.deepEqual(dependencias, []);
});

test('el frontend no importa fuentes internas del API', async () => {
  const frontend = path.join(raiz, 'frontend');
  const apiInterna = path.join(raiz, 'api/src') + path.sep;
  const archivos = [
    path.join(frontend, 'auth.js'),
    ...(await archivosEn(path.join(frontend, 'src'))),
  ];
  const dependencias = [];
  for (const archivo of archivos) {
    for (const especificador of await importaciones(archivo)) {
      const destino = especificador.startsWith('.') ? await resolverImport(archivo, especificador) : undefined;
      if (destino?.startsWith(apiInterna) || /api[\\/]+src(?:[\\/]|$)/i.test(especificador)) {
        dependencias.push(`${rutaRelativa(archivo)} -> ${especificador}`);
      }
    }
  }
  assert.deepEqual(dependencias, []);
});
