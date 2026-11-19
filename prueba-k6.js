import http from 'k6/http';
import { check, sleep } from 'k6';

// Configuración: tasa de llegada abierta acotada para calibración local
export const options = {
  scenarios: {
    calibracion_admision: {
      executor: 'constant-arrival-rate',
      rate: 10,             // 10 solicitudes POST por segundo
      timeUnit: '1s',
      duration: '15s',      // Total: ~150 inscripciones
      preAllocatedVUs: 10,
      maxVUs: 30,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://host.docker.internal:3001/api';
const TOKEN = __ENV.TOKEN;
const TURNO_ID = Number(__ENV.TURNO_ID || 2);

export default function () {
  if (!TOKEN) {
    throw new Error('Falta la variable de entorno TOKEN (JWT de un tutor como beto)');
  }

  // DNI único de 8 dígitos por VU e iteración
  const dniNum = 40000000 + (__VU * 100000) + __ITER;
  const documento = String(dniNum);

  // Clave de idempotencia única por operación lógica
  const idempotencyKey = `k6-vu${__VU}-iter${__ITER}-${Date.now()}`;

  const payload = JSON.stringify({
    turnoId: TURNO_ID,
    chico: {
      documento: documento,
      nombre: `Chico${__ITER}`,
      apellido: `PruebaVU${__VU}`,
      fechaNacimiento: '2018-06-16',
    },
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
      'Idempotency-Key': idempotencyKey,
    },
  };

  // 1. Envío de inscripción (admisión asíncrona con 202 Accepted)
  const resPost = http.post(`${BASE_URL}/inscripciones`, payload, params);

  if (resPost.status !== 202) {
    console.error(`POST /inscripciones falló -> status=${resPost.status} body=${resPost.body}`);
  }

  check(resPost, {
    'POST /inscripciones devuelve 202': (r) => r.status === 202,
    'POST devuelve estado pendiente': (r) => {
      if (r.status !== 202) return false;
      try {
        const body = r.json();
        return !body || !body.estado || body.estado === 'pendiente_de_validacion' || body.estado === 'Pendiente de validación';
      } catch (_) {
        return true;
      }
    },
  });

  // 2. Consulta liviana de turnos
  const resGet = http.get(`${BASE_URL}/turnos`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  if (resGet.status !== 200) {
    console.error(`GET /turnos falló -> status=${resGet.status} body=${resGet.body}`);
  }

  check(resGet, {
    'GET /turnos devuelve 200': (r) => r.status === 200,
  });

  sleep(0.1);
}