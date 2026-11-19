# Pruebas y verificación

Los comandos de esta guía se ejecutan desde la raíz del repositorio. Para preparar el entorno, seguir el [README principal](../README.md). Las pruebas de contrato y E6 generan datos persistentes en la base local; ejecutarlas en un entorno de desarrollo. Las suites que indican una base temporal crean y eliminan sus propios recursos.

## Verificación rápida

Desde PowerShell:

```powershell
Invoke-RestMethod http://localhost:3001/api/health
curl.exe -i http://localhost:8080/api/turnos
docker compose -f docker-compose.yml -f docker-compose.auth.yml exec frontend wget -qO- http://gateway:8000/health
docker compose -f docker-compose.yml -f docker-compose.auth.yml exec cola rabbitmq-diagnostics -q ping
```

Resultados esperados: health con `status: ok`, turnos sin token con 401 y `application/problem+json`, y broker disponible. La API no se consulta desde el host.

También se puede ejecutar la comprobación HTTP de todas las rutas, con Node.js 22 o posterior:

```powershell
node scripts/smoke.mjs
```

Para puertos diferentes: `node scripts/smoke.mjs http://localhost:3001 http://localhost:8080`, reemplazando las URLs.

La fitness function de arquitectura recorre los imports relativos de `api/src`, `auth/gateway/src` y el código fuente del frontend. Falla ante ciclos, dependencias desde `api/src/shared` hacia `api/src/modules` o imports del frontend hacia fuentes internas del API. No prohíbe el acceso a DB desde las rutas:

```powershell
node --test scripts/architecture.test.mjs
```

La suite HTTP E6 envía requests al gateway real y requiere el stack levantado con los dos archivos Compose. Usa tokens de tres usuarios del realm: un administrador y dos tutores distintos. El realm inicial trae un solo tutor (`beto`); para titularidad, creá un segundo usuario con rol `tutor` desde la consola de Keycloak (`http://localhost:8180/admin/`). No hace falta habilitar password grant: iniciá sesión con cada usuario desde el frontend y copiá el access token en la consola del navegador con `sessionStorage.getItem('colonia.access_token')`.

En PowerShell, cargá los tokens solo en la sesión actual (no los agregues al repositorio) y corré:

```powershell
$env:E6_ADMIN_TOKEN = '<access token de ana>'
$env:E6_TUTOR_A_TOKEN = '<access token de beto>'
$env:E6_TUTOR_B_TOKEN = '<access token del segundo tutor>'
node --test auth/gateway/test/e2e.test.mjs
```

`E6_GATEWAY_URL` permite cambiar el destino y por defecto es `http://localhost:8000`. La prueba crea un turno y una inscripción con datos únicos que quedan persistidos en la base; verifica 401 sin/con token inválido, 403 al crear un turno como tutor, 404 al acceder a la inscripción del otro tutor y que headers `X-Usuario-*` falsificados no cambian la identidad extraída del token.

Las pruebas de contrato de la API corren dentro de la red de Compose, con la identidad que pondría el gateway:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml run --rm --no-deps -v ./api/test:/app/test api node --test test/api.test.mjs
```

Cubren alta y actualización de turnos, alta de inscripciones, unicidad con pedidos concurrentes, titularidad, corrección, cancelación, rechazo por residencia, lista de espera, promoción por cupo o cancelación, el orden de asignación y los errores 400, 404 y 409.

Las pruebas de concurrencia de admisión usan las fuentes locales y una base temporal que se crea y elimina automáticamente (requieren permiso `CREATEDB`, disponible con el usuario del Compose local):

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml run --rm --no-deps -v ./api/src:/app/src:ro -v ./api/test:/app/test:ro -v ./api/migrations:/app/migrations:ro api node --test --test-concurrency=1 test/equidad.test.mjs test/asignacion.test.mjs
```

Fuerzan una pausa antes de que la primera inscripción sea visible y comprueban prioridad, independencia entre turnos y revalidación del período ante un cambio concurrente. Ejecutan rutas y asignador reales; no inician el consumidor de RabbitMQ y simulan residencia favorable para aislar la coordinación transaccional.

La suite del asignador compara sus resultados con el recorrido anterior en 24 escenarios y verifica continuidad después de cancelar la primera pendiente y aumentar cupo. También usa `FOR UPDATE NOWAIT` para comprobar que no bloquea filas sin cambios y `EXPLAIN (ANALYZE, BUFFERS)` para comparar trabajo real. En una ejecución local con 5.000 en espera, una validación nueva y una plaza libre, el SELECT anterior registró 6.483 accesos a buffers frente a 67 para todas las consultas del asignador nuevo. Es una medición de ese escenario, no una prueba de capacidad de producción; la prueba exige una reducción de al menos la mitad, sin fijar tiempos de ejecución.

La misma suite también prueba reintentos idempotentes concurrentes, conflictos de contenido, aislamiento por tutor, respuesta original después de cancelación/cierre, validación del header y rollback completo ante una falla del outbox.

Además, ejecuta el procesador real `resolverInscripcion` con un cliente de padrón inyectado y permisos reales de PostgreSQL. Verifica errores transitorios, saturación, conservación del orden, consumo de permiso en cada intento y una respuesta lenta que no permite adelantar a otra inscripción. Estas pruebas invocan explícitamente cada intento; no demuestran todavía recuperación automática ni backoff del broker.

Las pruebas del cliente y del simulador no necesitan Docker, credenciales ni PostgreSQL:

```powershell
node --test api/test/padron.test.mjs api/test/padron-reintentos.test.mjs
```

Para probar la ventana móvil con PostgreSQL real y tres procesos independientes, en una base temporal que se elimina al finalizar:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml run --rm --no-deps -v ./api/src:/app/src:ro -v ./api/test:/app/test:ro -v ./api/migrations:/app/migrations:ro api node --test test/padron-limite.test.mjs
```

Esta suite verifica el cambio de segundo, la limpieza de vencidos, las reservas concurrentes y el límite observado en los inicios reales del adaptador entre procesos. No representa una prueba de carga provincial ni una medición de la recepción de paquetes en un padrón HTTP externo.

Para probar la coordinación del outbox con PostgreSQL y RabbitMQ reales, usando una base temporal y una cola exclusiva que se eliminan al finalizar:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml run --rm --no-deps -v ./api/src:/app/src:ro -v ./api/test:/app/test:ro -v ./api/migrations:/app/migrations:ro api node --test test/outbox.test.mjs
```

Comprueba exclusión entre publicadores, progreso mientras una fila espera confirmación, rollback por fallo del broker, conservación de mensajes ya marcados, recuperación tras terminar otra réplica y confirms reales sin duplicados en el caso sin fallas. También fuerza un error al marcar después de publicar para demostrar la reentrega esperable con la garantía de al menos una vez.

Para probar reentregas del consumidor con PostgreSQL y RabbitMQ reales, una base temporal y una cola exclusiva:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml run --rm --no-deps -v ./api/src:/app/src:ro -v ./api/test:/app/test:ro -v ./api/migrations:/app/migrations:ro api node --test test/consumidor.test.mjs
```

Verifica exclusión entre procesos, reentrega después de commit sin ACK, NACK ante trabajo en vuelo o fallido, ausencia de nuevas consultas/escrituras para resultados persistidos, recuperación tras caída del proceso o pérdida de sesión, rollback de residencia y asignación, cancelación concurrente y permisos del padrón con las 10 conexiones de consumo ocupadas. Las fallas antes del commit muestran el límite de la garantía: la consulta al padrón puede repetirse, pero no se guarda un resultado parcial ni se duplica el cupo.

Para verificar CORS y el reenvío de la clave en el gateway con JWT/JWKS de prueba y una API simulada, sin iniciar Keycloak ni modificar datos:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml run --rm --no-deps -v ./auth/gateway/src:/app/src:ro -v ./auth/gateway/test:/app/test:ro gateway node --test test/idempotencia.test.mjs
```

