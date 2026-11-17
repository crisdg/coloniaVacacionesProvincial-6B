# Colonia de Vacaciones Provincial

Arquitectura de Software 1 · UNAHUR · Escenario 6B

## Alcance de este avance

Login delegado en Keycloak con los dos roles del escenario 6B, API de turnos e inscripciones sobre PostgreSQL, y validación de residencia por cola.

La arquitectura sigue el **ADR-001**: monolito modular, un único módulo de negocio **Inscripciones**. **Turno** es una entidad de ese módulo. Las rutas están en `api/src/modules/inscripciones/`: `routes.js` para `/inscripciones` y `turnos.routes.js` para `/turnos`.

**Implementado:** autenticación OIDC con autorización por rol, las operaciones de turnos e inscripciones, y la cola que consulta el padrón simulado y asigna el cupo en orden. La decisión de validar el token solo en el gateway está en [docs/adr/ADR-007-validacion-del-token.md](docs/adr/ADR-007-validacion-del-token.md). Complementa el ADR-003 del escenario (OIDC y RBAC) y no lo reemplaza.
**Pendiente:** pruebas de carga. Este Compose no demuestra las 200.000 familias ni la elasticidad del enunciado.

Roles, como en el enunciado:

| Usuario | Clave | Rol | Puede | No puede |
| --- | --- | --- | --- | --- |
| `ana` | `ana123` | administrador | Gestionar turnos, cupos e inscripciones, y consultar | — |
| `beto` | `beto123` | tutor | Consultar turnos, solicitar una inscripción y consultar inscripciones | Crear o modificar turnos, corregir o cancelar inscripciones |

Esas claves son las de los usuarios de prueba del realm versionado. La contraseña del admin de Keycloak no está en el repo: va en `.env`. No hay `client_secret`: ningún servicio llama a la API sin un usuario.

## Levantar el proyecto

Requisito: Docker Desktop funcionando, con Docker Compose.

1. En PowerShell, desde la raíz del proyecto, crear la configuración local si todavía no existe:

   ```powershell
   Copy-Item .env.example .env
   ```

2. Completar en `.env` las variables `POSTGRES_PASSWORD`, `RABBITMQ_PASSWORD` y `KC_ADMIN_PASSWORD`. No dejar valores vacíos. No sobrescribir un `.env` existente: contiene las credenciales usadas para inicializar los volúmenes.

3. Construir y levantar el esqueleto junto con el anexo de identidad:

   ```powershell
   docker compose -f docker-compose.yml -f docker-compose.auth.yml up -d --build
   ```

4. Comprobar el arranque:

   ```powershell
   docker compose -f docker-compose.yml -f docker-compose.auth.yml ps
   ```

   PostgreSQL, API, RabbitMQ y Keycloak deben quedar `healthy`; frontend, gateway y Swagger deben estar en ejecución.

Accesos:

- Frontend (login): http://localhost:3001
- Swagger UI: http://localhost:8080
- Keycloak: http://localhost:8180 (realm `colonia`)
- Gateway, única puerta de la API: http://localhost:8000
- Estado público: http://localhost:3001/api/health

El login del frontend exige el redirect exacto `http://localhost:3001/`. El de Swagger exige `http://localhost:8080/oauth2-redirect.html`. Esos puertos no se cambian: están declarados en el realm. En Swagger, Authorize usa el cliente `swagger-ui`, secreto vacío y scopes `openid` y `profile`.

Keycloak importa `auth/keycloak/realm-colonia.json` solo si el volumen `colonia_keycloak` está vacío. Para reimportar el realm hay que borrar ese volumen.

## Servicios y conexiones

- `frontend`: página de login (Authorization Code + PKCE, cliente público `frontend`). Nginx reenvía `/api/` al gateway.
- `gateway`: valida firma, `iss`, `aud` y `exp`, aplica el rol y recién ahí reenvía a la API. Publica el puerto 8000.
- `keycloak`: proveedor OIDC. Realm `colonia` versionado en el repo. Publica el puerto 8180 para que el navegador pueda iniciar sesión.
- `api`: Node.js + Express. Un único módulo `inscripciones`, que también contiene las rutas de turnos. Se conecta a `db:5432` y a `cola:5672`, aplica sus migraciones al arrancar, publica la validación de residencia y la consume. No publica un puerto al host y no valida el token: toma el usuario y los roles de los headers `X-Usuario-Id` y `X-Usuario-Roles`, que pone el gateway.
- `db`: PostgreSQL, sin puerto publicado, con healthcheck y volumen con nombre `colonia_pgdata`.
- `cola`: RabbitMQ, sin puerto publicado, con healthcheck y volumen `colonia_rabbitmq`. La API publica y consume la cola durable `colonia.residencia` por el exchange por defecto: un mensaje lo toma un solo consumidor.
- `swagger-ui`: muestra `openapi.yaml`, se autoriza contra Keycloak y reenvía `/api/` al gateway.

El padrón provincial está simulado dentro de la API: un DNI que termina en `0` no reside en la jurisdicción de la convocatoria; el resto sí. Cada consulta, también un reintento o una corrección administrativa, necesita un permiso global registrado en `colonia.permisos_padron`. El límite es **como máximo 50 inicios de consulta en una ventana móvil de un segundo**, compartido por todas las réplicas conectadas a la misma base. No se reinicia el cupo al cambiar de segundo ni al reiniciar un proceso. Si la consulta falla, la inscripción sigue en `pendiente_de_validacion` y el mensaje se vuelve a encolar.

La concesión usa el reloj de PostgreSQL y un bloqueo asesor transaccional compartido: cuenta los permisos vigentes, elimina los vencidos y registra uno nuevo si hay lugar. Todas esas operaciones ocurren bajo el mismo bloqueo. Si está lleno, devuelve cuánto falta para que venza el más antiguo; se espera fuera de la transacción y se vuelve a comprobar. La consulta externa también ocurre fuera del bloqueo. Si PostgreSQL falla, no se consulta el padrón sin permiso.

Un permiso debe usarse antes de 100 ms, medidos con reloj monotónico desde **antes** de solicitarlo. Si llegó tarde por red, bloqueo o pausa del proceso, el cliente lo descarta y solicita otro; no lo reintegra. PostgreSQL conserva cada permiso durante 1.100 ms (ventana de 1.000 ms más margen de vigencia). Así se cubre el desfase entre concesión e inicio del adaptador, que se invoca directamente al verificar la vigencia, sin otra espera intermedia. La garantía se refiere al inicio de la llamada al adaptador: un futuro adaptador HTTP debe iniciar el pedido inmediatamente, sin agregar una cola interna antes del envío. La latencia de transporte hasta un proveedor real requiere además verificar su propia política de tasa.

Este margen es deliberadamente conservador: el máximo teórico sostenido es aproximadamente **45,5 consultas/s** con la configuración de 50; puede ser menor si se descartan permisos o hay errores. Se prioriza no sobrepasar el límite antes que aprovechar cada consulta disponible. La variable `PADRON_CONSULTAS_POR_SEGUNDO` se valida al arrancar: admite enteros de 1 a 50, usa 50 si no está definida y rechaza valores inválidos o mayores, sin reemplazarlos silenciosamente. Todas las réplicas deben usar el mismo valor. El límite regula la tasa global, no garantiza equidad entre consumidores; la prioridad de cupos sigue resolviéndose por turno en la base.

La integración está separada en `padron-limite.js` (permisos globales en PostgreSQL), `padron-cliente.js` (esperar permiso y consultar) y `padron-simulado.js` (adaptador de residencia). `padron.js` compone esas piezas y conserva la función `consultarPadron` usada por las rutas y el consumidor. El adaptador recibe documento y jurisdicción, devuelve `true`/`false` o lanza un error técnico; una respuesta inválida también es error, nunca rechazo por residencia.

Las pruebas crean instancias del simulador con una secuencia de escenarios: `{ demoraMs: 500 }`, `{ error: 'NO_DISPONIBLE' }` o `{ error: 'SATURADO', reintentarEnMs: 2500 }`. Se consumen por orden de inicio de llamada, sin azar ni configuración global; al agotarse vuelve la regla normal del DNI. Se puede inyectar una espera controlada para liberar la respuesta desde la prueba sin dormir realmente. La demo usa una instancia sin escenarios de falla y no expone endpoints para activarlos.

`SATURADO` simula el rechazo externo por tasa (equivalente a HTTP 429), distinto de `LIMITE_LOCAL` al agotar el presupuesto de espera del regulador. `reintentarEnMs` es información disponible para la futura política de reintentos: el consumidor todavía conserva su reencolado actual. `esperaMaximaMs` limita la obtención de un permiso vigente, incluido el tiempo de consulta a PostgreSQL; el timeout de la consulta externa y el backoff se implementarán en el paso 8.

Las conexiones **entre servicios** usan nombres DNS de Compose. `localhost` se usa solo en las URLs del navegador; el healthcheck de la API usa loopback para comprobar el propio contenedor, no para conectarse a otro servicio.

El proyecto Compose se llama `colonia-vacaciones`; sus volúmenes están separados de los del template de cursos. No es necesario borrar los volúmenes antiguos.

## Contrato y operaciones

El archivo `openapi.yaml` define esquemas, ejemplos, validaciones y errores. El chico se representa como `chico` (esquema `Chico`). Cada turno pertenece a una `convocatoriaId` y una `sedeId`, fijadas al crearlo; las inscripciones obtienen ambos datos del turno. Convocatorias y sedes son datos precargados por la migración, sin endpoints de gestión: la convocatoria `verano-2027` y las sedes 1, 2 y 3. La convocatoria define la jurisdicción a validar.

Operaciones de turnos:

- `GET /turnos`: listar.
- `GET /turnos/{id}`: consultar detalle y disponibilidad.
- `POST /turnos`: crear.
- `PATCH /turnos/{id}`: actualizar nombre, cupo y fechas.

Operaciones de inscripciones:

- `POST /inscripciones`: recibir una solicitud para el chico en un turno. Responde `202 Accepted`, estado `pendiente_de_validacion` y `Location` para consultar el resultado.
- `GET /inscripciones`: consultar las propias inscripciones (tutor) o todas (administrador).
- `GET /inscripciones/{id}`: consultar una inscripción propia (tutor) o cualquiera (administrador). La ajena responde 404 al tutor.
- `PATCH /inscripciones/{id}`: corregir datos del mismo chico, sin cambiar turno, estado ni orden (administrador). Si cambia el DNI, el padrón se consulta antes de aceptar: sin residencia responde 409 y el DNI anterior queda igual; si el padrón no responde, 503.
- `POST /inscripciones/{id}/cancelaciones`: cancelar con motivo obligatorio (administrador).

`POST /inscripciones` acepta el header opcional `Idempotency-Key` (de 1 a 128 caracteres: letras ASCII, números, `.`, `_`, `:`, `-`). El cliente genera una clave por solicitud, por ejemplo un UUID, y la conserva si pierde la respuesta o necesita reintentar. El gateway permite y reenvía ese header.

La clave se asocia al tutor autenticado y al contenido validado de la solicitud. La misma clave con los mismos datos normalizados devuelve el `202`, cuerpo y `Location` originales, incluidos `id` y `ordenRecepcion`; otros datos con esa clave devuelven `409`. El orden de los campos JSON no importa y los textos se comparan después del recorte de espacios de la validación habitual. Una clave inválida devuelve `400`.

La reserva de clave, inscripción, outbox y respuesta original se guardan en una sola transacción. La clave primaria `(tutor_id, clave)` coordina reintentos concurrentes entre réplicas antes de bloquear el turno. Si la operación falla, todo se revierte y la clave puede reintentarse. Las aceptaciones se conservan sin expiración automática: esa persistencia consume espacio, pero evita que un reintento tardío se interprete como una nueva admisión. No se eliminan claves en este avance.

El reintento recupera la aceptación original incluso si cerró el período o la inscripción fue corregida, confirmada, rechazada o cancelada. Para el estado actual se usa `GET /inscripciones/{id}`. Una solicitud nueva después de cancelación o rechazo usa otra clave. Sin header se mantiene el comportamiento anterior: otro POST para un DNI activo devuelve `409`. Una clave distinta nunca permite eludir la unicidad por DNI y convocatoria.

Operación técnica:

- `GET /health`: responde 200 si API y PostgreSQL están disponibles, o 503 si falla la comprobación de la base.

Las rutas se invocan desde el navegador con el prefijo del proxy: por ejemplo, `/api/turnos`. La API internamente recibe `/turnos`.

En Swagger, **Try it out** sin Authorize devuelve 401. Con `beto`, crear un turno devuelve 403. Con `ana`, crear un turno devuelve 201; con `beto`, inscribir a un chico en ese turno devuelve 202. JSON mal formado devuelve 400 y una ruta inexistente, 404.

## Reglas y flujo

Implementado: roles, titularidad, edad, período, unicidad por DNI y convocatoria, orden de recepción, corrección, cancelación, consulta al padrón y asignación de cupo.

- El administrador consulta, corrige y cancela inscripciones con motivo; también gestiona turnos, cupos y fechas. El tutor inscribe y consulta sus propias inscripciones. El gateway aplica el rol y la API aplica la titularidad: un tutor no lee inscripciones ajenas.
- El chico debe tener **de 6 a 12 años inclusive al registrar la inscripción**. Se calcula desde su fecha de nacimiento usando la fecha del servidor en `America/Argentina/Buenos_Aires`, no la fecha del inicio del turno ni una edad enviada por el cliente.
- Se admite **una sola inscripción activa por DNI y convocatoria**, aunque se elijan turnos, sedes o tutores distintos. Son activas: `pendiente_de_validacion`, `confirmada` y `en_lista_de_espera`. Canceladas y rechazadas no bloquean una nueva solicitud, que recibe un nuevo orden.
- La inscripción es gratuita. El período de recepción incluye la apertura y excluye el cierre. La validación puede terminar después del cierre si la solicitud fue recibida a tiempo.

Flujo funcional:

1. El tutor elige un turno. El sistema comprueba datos, edad, período abierto y ausencia de inscripción activa en la convocatoria. Estas validaciones y la unicidad deben mantenerse también con solicitudes concurrentes.
2. La admisión bloquea el turno antes de generar el orden y guarda durablemente la solicitud y un mensaje en `colonia.salida`, en la misma transacción. Comprueba las fechas vigentes del turno y toma la hora de PostgreSQL después de obtener ese bloqueo. Se responde `202 Accepted` con estado `pendiente_de_validacion`, `ordenRecepcion` y la ubicación para consultar el resultado. Esto no confirma un cupo. Si RabbitMQ no está, el mensaje queda en la bandeja y se publica cuando el broker vuelve.
3. La cola procesa la validación de residencia con el regulador global de **hasta 50 inicios de consulta en cualquier ventana móvil de un segundo**, aunque existan varios consumidores. Una falla técnica mantiene la solicitud pendiente para reintentar; no equivale a un rechazo.
4. Si reside en la jurisdicción, se asigna cupo de forma transaccional respetando el orden. Queda `confirmada` si corresponde una plaza, o `en_lista_de_espera` si no alcanza el cupo. Si el padrón determina que no reside, queda `rechazada`, con motivo.
5. Una respuesta rápida del padrón no permite adelantar solicitudes anteriores pendientes del mismo turno. La asignación posterior de ese turno espera su resolución; no se implementan reservas temporales ni plazos de corrección. Los otros turnos pueden continuar. Esta elección protege la equidad a costa de demorar confirmaciones si el padrón falla.
6. Al aumentar el cupo o cancelar una confirmada, se continúa asignando en orden. Cancelar una pendiente o una inscripción en espera no libera una plaza ocupada. Una solicitud cancelada no puede confirmarse por un resultado tardío del padrón.

Estados: `pendiente_de_validacion`, `confirmada`, `en_lista_de_espera`, `rechazada` y `cancelada`. Los dos últimos son finales.

Los publicadores del outbox se coordinan en PostgreSQL con `FOR UPDATE SKIP LOCKED`: cada uno bloquea una fila pendiente, espera el confirm de RabbitMQ y marca `publicado_en` dentro de la misma transacción. Las otras réplicas omiten esa fila y pueden publicar otras. Se procesan hasta 20 mensajes por ciclo, con una transacción por mensaje; una falla no revierte las publicaciones anteriores. No se necesitan leases ni una migración nueva.

Esta elección mantiene una conexión a PostgreSQL y el bloqueo de esa fila mientras espera el confirm (timeout de 5 segundos). Si falla la publicación, se revierte la transacción; si termina el proceso, PostgreSQL libera el bloqueo al detectar la desconexión y otra réplica puede retomar el mensaje. La entrega sigue siendo **al menos una vez**: si RabbitMQ acepta el mensaje pero se pierde el confirm o falla el marcado/commit, puede publicarse de nuevo. La coordinación evita que réplicas sanas publiquen simultáneamente la misma fila; no convierte PostgreSQL y RabbitMQ en una transacción distribuida. El consumidor debe tolerar reentregas. El orden de publicación entre réplicas puede variar; la equidad depende del orden durable de admisión y del asignador, no del orden de la cola.

Para desplegar este cambio, detener los publicadores anteriores y arrancar todas las réplicas con la nueva versión. Una réplica vieja que consulta sin bloquear no participa de esta coordinación.

La prioridad se define en la admisión al sistema, no en el clic del navegador ni en la llegada al gateway. Dentro de un turno, recepción, asignación, cancelación y cambios de cupo usan el mismo bloqueo: una solicitud posterior no puede obtener una plaza mientras una anterior con orden asignado todavía se está guardando. El bloqueo dura hasta commit o rollback y nunca abarca la consulta al padrón. Otros turnos pueden avanzar independientemente. `ordenRecepcion` es global e inmutable, puede tener saltos y no representa la posición actual en la lista de espera. Si el período cierra mientras una solicitud espera el bloqueo de admisión, se rechaza con 409.

Las correcciones administrativas corresponden al mismo chico y conservan identificador, turno, convocatoria y orden original. Vuelven a comprobar la edad a la **fecha original de inscripción**. Si cambia el DNI, la residencia se valida antes de aceptar el cambio. No permiten cambiar libremente el estado ni corregir una inscripción cancelada o rechazada.

El cupo es entero no negativo y no se reduce por debajo de los confirmados. Cambiar fechas del turno no invalida solicitudes existentes. La sede y convocatoria del turno no se modifican.

La consigna plantea 40.000 cupos, 80 sedes, unas 200.000 familias, apertura a las 9 y uso estacional en nube. La cola y el orden durable forman parte del diseño para el pico; este Compose local **no demuestra elasticidad ni capacidad para esa carga**. Las pruebas de carga quedan pendientes.

Las reservas provisionales por correcciones, el plazo de 48 horas y las prórrogas permanecen fuera del alcance. No se agregan módulos ni rutas por estos ajustes.

**Estado actual:** sin token, las operaciones de negocio responden 401. Con token de un rol que no alcanza, 403. Con un rol habilitado, la API guarda y devuelve datos reales. El payload no permite elegir un `tutorId`: la identidad sale del token.

## Configuración y persistencia

`.env.example` contiene nombres de variables y valores no secretos. `.env` está excluido por `.gitignore`. Si esta carpeta todavía no tiene Git inicializado, estas exclusiones se aplicarán cuando se cree el repositorio.

`db/init.sql` crea únicamente el esquema `colonia` y solo corre cuando el volumen está vacío. El modelo está en `api/migrations/`: la API aplica al arrancar las migraciones que falten y las registra en `colonia.migraciones`, así funciona también con un volumen existente. Una migración nueva se agrega como otro archivo numerado, sin editar las ya aplicadas.

La migración `004_ventana_padron.sql` reemplaza el contador técnico por el registro de permisos; no modifica inscripciones. Para esta transición hay que detener todas las APIs/consumidores anteriores, esperar al menos 1,1 segundos desde su última consulta al padrón y luego arrancar la versión nueva. No admite mezclar versiones viejas y nuevas durante el despliegue. Los reinicios posteriores conservan los permisos en PostgreSQL y no requieren vaciar la tabla.

Modificar credenciales en `.env` no actualiza automáticamente las credenciales ya almacenadas por PostgreSQL o RabbitMQ.

Para apagar conservando los datos:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml down
```

Para validar la configuración sin imprimir contraseñas:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml config --quiet
```

Para esperar a que terminen los healthchecks al iniciar:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml up -d --build --wait --wait-timeout 180
```

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

Las pruebas de contrato de la API corren dentro de la red de Compose, con la identidad que pondría el gateway:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml run --rm --no-deps -v ./api/test:/app/test api node --test test/api.test.mjs
```

Cubren alta y actualización de turnos, alta de inscripciones, unicidad con pedidos concurrentes, titularidad, corrección, cancelación, rechazo por residencia, lista de espera, promoción por cupo o cancelación, el orden de asignación y los errores 400, 404 y 409.

Las pruebas de concurrencia de admisión usan las fuentes locales y una base temporal que se crea y elimina automáticamente (requieren permiso `CREATEDB`, disponible con el usuario del Compose local):

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml run --rm --no-deps -v ./api/src:/app/src:ro -v ./api/test:/app/test:ro -v ./api/migrations:/app/migrations:ro api node --test test/equidad.test.mjs
```

Fuerzan una pausa antes de que la primera inscripción sea visible y comprueban prioridad, independencia entre turnos y revalidación del período ante un cambio concurrente. Ejecutan rutas y asignador reales; no inician el consumidor de RabbitMQ y simulan residencia favorable para aislar la coordinación transaccional.

La misma suite también prueba reintentos idempotentes concurrentes, conflictos de contenido, aislamiento por tutor, respuesta original después de cancelación/cierre, validación del header y rollback completo ante una falla del outbox.

Además, ejecuta el procesador real `resolverInscripcion` con un cliente de padrón inyectado y permisos reales de PostgreSQL. Verifica errores transitorios, saturación, conservación del orden, consumo de permiso en cada intento y una respuesta lenta que no permite adelantar a otra inscripción. Estas pruebas invocan explícitamente cada intento; no demuestran todavía recuperación automática ni backoff del broker.

Las pruebas del cliente y del simulador no necesitan Docker, credenciales ni PostgreSQL:

```powershell
node --test api/test/padron.test.mjs
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

Para verificar CORS y el reenvío de la clave en el gateway con JWT/JWKS de prueba y una API simulada, sin iniciar Keycloak ni modificar datos:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml run --rm --no-deps -v ./auth/gateway/src:/app/src:ro -v ./auth/gateway/test:/app/test:ro gateway node --test test/idempotencia.test.mjs
```

## Checklist del avance

- [x] Un servicio por contenedor del C4: frontend, API, base y cola.
- [x] Contrato OpenAPI de colonia y Swagger UI.
- [x] Base sin puerto publicado, con volumen con nombre y healthcheck.
- [x] Comunicación entre servicios por nombre.
- [x] Configuración mediante variables de entorno y secretos en `.env` ignorado.
- [x] Arranque documentado con los dos archivos de Compose.
- [x] Keycloak en el Compose, realm `colonia` versionado e importado al arrancar.
- [x] Roles `tutor` y `administrador`, con un usuario de prueba cada uno.
- [x] Cliente público del frontend con PKCE y redirect exacto.
- [x] Token validado solo en el gateway: firma, `iss`, `aud` y `exp` ([ADR-007](docs/adr/ADR-007-validacion-del-token.md)).
- [x] 401 y 403 con Problem Details, y `securitySchemes` en `openapi.yaml`.
- [x] La API no publica puerto. La contraseña de admin de Keycloak está en `.env`.
- [x] Turnos e inscripciones persistidos en PostgreSQL, con migraciones y pruebas de contrato.
- [x] Cola y padrón simulado con ventana móvil global de hasta 50 inicios por segundo y vigencia de permisos; asignación de cupo en orden.

La guía original se conserva en `docs/clase10-original.md`. El BFF mobile del ejemplo no forma parte del Compose de colonia; su código se conserva como referencia en `docs/template-bff-mobile/`.

