# Colonia de Vacaciones Provincial

Arquitectura de Software 1 · UNAHUR · Escenario 6B

## Alcance de este avance

Esqueleto correspondiente al avance del **22/10**: servicios del C4 levantados con Compose y contrato OpenAPI del caso de uso.

La arquitectura es **monolítica**, con un único módulo de negocio: **Inscripciones**. **Turno** es una entidad de ese módulo, que reúne la gestión de inscripciones, turnos y cupos.

El esqueleto mantiene dos archivos de rutas dentro de `api/src/modules/inscripciones/`: `routes.js` para `/inscripciones` y `turnos.routes.js` para `/turnos`. Separar las rutas por recurso no implica tener módulos distintos. Las entidades y sus reglas se implementarán después; por ahora no hay clases de dominio ni lógica de negocio.

**Implementado:** infraestructura, pantalla inicial, proxy HTTP, Swagger y `GET /health` con consulta real a PostgreSQL.
**Pendiente:** lógica de negocio. Todas las rutas de turnos e inscripciones responden **501 Not Implemented**, con Problem Details. Las respuestas de éxito del contrato describen el comportamiento que se implementará después, no una funcionalidad ya disponible.

No hay login ni permisos aplicados. Keycloak, OIDC, roles, validación de tokens y respuestas 401/403 se incorporarán en la etapa de seguridad.

## Levantar el proyecto

Requisito: Docker Desktop funcionando, con Docker Compose.

1. En PowerShell, desde la raíz del proyecto, crear la configuración local si todavía no existe:

   ```powershell
   Copy-Item .env.example .env
   ```

2. Completar en `.env` las variables `POSTGRES_PASSWORD` y `RABBITMQ_PASSWORD`. No dejar valores vacíos. No sobrescribir un `.env` existente: contiene las credenciales usadas para inicializar los volúmenes.

3. Construir y levantar:

   ```powershell
   docker compose up -d --build
   ```

4. Comprobar el arranque:

   ```powershell
   docker compose ps
   docker compose logs api
   ```

   PostgreSQL, API y RabbitMQ deben quedar `healthy`; frontend y Swagger deben estar en ejecución.

Accesos con los puertos predeterminados:

- Frontend inicial: http://localhost:3001
- Swagger UI: http://localhost:8080
- Estado vía frontend: http://localhost:3001/api/health
- Estado vía Swagger: http://localhost:8080/api/health

Los puertos del host se configuran con `FRONTEND_PORT` y `SWAGGER_PORT`. El contrato usa `/api` como servidor relativo: cambiar esos puertos no requiere editar OpenAPI.

## Servicios y conexiones

- `frontend`: página inicial que se convertirá en la SPA. Nginx sirve la página y reenvía `/api/` a `http://api:3000/`, configurado por `API_URL`.
- `api`: Node.js + Express. Un único módulo `inscripciones`, que también contiene las rutas de turnos. Se conecta a `db:5432`. No publica un puerto al host.
- `db`: PostgreSQL, sin puerto publicado, con healthcheck y volumen con nombre `colonia_pgdata`.
- `cola`: RabbitMQ, sin puerto publicado, con healthcheck y volumen `colonia_rabbitmq`. Aún no tiene productores ni consumidores: no participa del flujo inicial.
- `swagger-ui`: muestra `openapi.yaml` y reenvía `/api/` a la API por nombre de servicio. Comparte la red backend para ese proxy.

**Requisito pendiente de implementación:** simular el padrón provincial y validar residencia en la jurisdicción, con un límite global de 50 consultas por segundo, incluidos reintentos. Es obligatorio para la entrega funcional; no es una mejora opcional. En este avance no se agrega su servicio ni se integra la cola.

Las conexiones **entre servicios** usan nombres DNS de Compose. `localhost` se usa solo en las URLs del navegador; el healthcheck de la API usa loopback para comprobar el propio contenedor, no para conectarse a otro servicio.

El proyecto Compose se llama `colonia-vacaciones`; sus volúmenes están separados de los del template de cursos. No es necesario borrar los volúmenes antiguos.

## Contrato y operaciones

El archivo `openapi.yaml` define esquemas, ejemplos, validaciones previstas y errores. El chico se representa como `chico` (esquema `Chico`). Cada turno pertenece a una `convocatoriaId` y una `sedeId`, fijadas al crearlo; las inscripciones obtienen ambos datos del turno. Convocatorias y sedes se prevén como datos precargados, sin módulos ni endpoints de gestión adicionales. La convocatoria define la jurisdicción a validar.

Operaciones de turnos:

- `GET /turnos`: listar.
- `GET /turnos/{id}`: consultar detalle y disponibilidad.
- `POST /turnos`: crear.
- `PATCH /turnos/{id}`: actualizar nombre, cupo y fechas.

Operaciones de inscripciones:

- `POST /inscripciones`: recibir una solicitud para el chico en un turno. El contrato prevé `202 Accepted`, estado `pendiente_de_validacion` y `Location` para consultar el resultado. Actualmente devuelve 501.
- `GET /inscripciones`: consultar las propias inscripciones (tutor) o todas (administrador).
- `GET /inscripciones/{id}`: consultar una inscripción propia (tutor) o cualquiera (administrador).
- `PATCH /inscripciones/{id}`: corregir datos del mismo chico, sin cambiar turno, estado ni orden (administrador).
- `POST /inscripciones/{id}/cancelaciones`: cancelar con motivo obligatorio (administrador).

Operación técnica:

- `GET /health`: responde 200 si API y PostgreSQL están disponibles, o 503 si falla la comprobación de la base.

Las rutas se invocan desde el navegador con el prefijo del proxy: por ejemplo, `/api/turnos`. La API internamente recibe `/turnos`.

En Swagger, **Try it out** devuelve 501 en todas las operaciones de negocio, sin guardar ni exponer datos personales. El listado no se reemplaza por un listado público de todos los tutores. JSON mal formado devuelve 400 y una ruta inexistente devuelve 404.

## Reglas y flujo previstos (todavía no implementados)

- El administrador consulta, corrige y cancela inscripciones con motivo; también gestiona turnos, cupos y fechas. El tutor inscribe y consulta sus propias inscripciones. El login y los permisos se incorporarán después.
- El chico debe tener **de 6 a 12 años inclusive al registrar la inscripción**. Se calcula desde su fecha de nacimiento usando la fecha del servidor en `America/Argentina/Buenos_Aires`, no la fecha del inicio del turno ni una edad enviada por el cliente.
- Se admite **una sola inscripción activa por DNI y convocatoria**, aunque se elijan turnos, sedes o tutores distintos. Son activas: `pendiente_de_validacion`, `confirmada` y `en_lista_de_espera`. Canceladas y rechazadas no bloquean una nueva solicitud, que recibe un nuevo orden.
- La inscripción es gratuita. El período de recepción incluye la apertura y excluye el cierre. La validación puede terminar después del cierre si la solicitud fue recibida a tiempo.

Flujo funcional previsto:

1. El tutor elige un turno. El sistema comprueba datos, edad, período abierto y ausencia de inscripción activa en la convocatoria. Estas validaciones y la unicidad deben mantenerse también con solicitudes concurrentes.
2. Se guarda durablemente la solicitud y su orden de recepción antes de consultar el padrón. Se responde `202 Accepted` con estado `pendiente_de_validacion` y la ubicación para consultar el resultado. Esto no confirma un cupo.
3. La cola permite procesar la validación de residencia sin superar **50 consultas por segundo en total**, aunque existan varios consumidores. Una falla técnica mantiene la solicitud pendiente para reintentar; no equivale a un rechazo.
4. Si reside en la jurisdicción, se asigna cupo de forma transaccional respetando el orden. Queda `confirmada` si corresponde una plaza, o `en_lista_de_espera` si no alcanza el cupo. Si el padrón determina que no reside, queda `rechazada`, con motivo.
5. Una respuesta rápida del padrón no permite adelantar solicitudes anteriores pendientes del mismo turno. La asignación posterior de ese turno espera su resolución; no se implementan reservas temporales ni plazos de corrección. Los otros turnos pueden continuar. Esta elección protege la equidad a costa de demorar confirmaciones si el padrón falla.
6. Al aumentar el cupo o cancelar una confirmada, se continúa asignando en orden. Cancelar una pendiente o una inscripción en espera no libera una plaza ocupada. Una solicitud cancelada no puede confirmarse por un resultado tardío del padrón.

Estados: `pendiente_de_validacion`, `confirmada`, `en_lista_de_espera`, `rechazada` y `cancelada`. Los dos últimos son finales.

Las correcciones administrativas corresponden al mismo chico y conservan identificador, turno, convocatoria y orden original. Deben volver a comprobar unicidad y edad a la **fecha original de inscripción**; si cambia el DNI, se valida residencia antes de aceptar el cambio. No permiten cambiar libremente el estado ni corregir una inscripción cancelada o rechazada.

El cupo es entero no negativo y no se reduce por debajo de los confirmados. Cambiar fechas del turno no invalida solicitudes existentes. La sede y convocatoria del turno no se modifican.

La consigna plantea 40.000 cupos, 80 sedes, unas 200.000 familias, apertura a las 9 y uso estacional en nube. La cola y el orden durable forman parte del diseño para el pico; este Compose local **no demuestra elasticidad ni capacidad para esa carga**. El procesamiento, la recuperación ante fallas y las pruebas de carga quedan pendientes.

La residencia mediante padrón simulado es un requisito de la entrega funcional. Las reservas provisionales por correcciones, el plazo de 48 horas y las prórrogas permanecen fuera del alcance. No se agregan módulos ni rutas por estos ajustes.

**Estado actual:** todas las operaciones de negocio siguen respondiendo 501. No se guarda ni modifica información de chicos. Los roles son requisitos del diseño, no controles implementados; el payload no permite elegir un `tutorId`, cuya identidad se resolverá en la etapa OIDC.

## Configuración y persistencia

`.env.example` contiene nombres de variables y valores no secretos. `.env` está excluido por `.gitignore`. Si esta carpeta todavía no tiene Git inicializado, estas exclusiones se aplicarán cuando se cree el repositorio.

`db/init.sql` crea únicamente el esquema `colonia`, sin tablas de cursos ni inscripciones simuladas. El modelo de negocio se incorporará con migraciones. Este script solo corre cuando el volumen está vacío.

Modificar credenciales en `.env` no actualiza automáticamente las credenciales ya almacenadas por PostgreSQL o RabbitMQ.

Para apagar conservando los datos:

```powershell
docker compose down
```

Para validar la configuración sin imprimir contraseñas:

```powershell
docker compose config --quiet
```

Para esperar a que terminen los healthchecks al iniciar:

```powershell
docker compose up -d --build --wait --wait-timeout 180
```

## Verificación rápida

Desde PowerShell:

```powershell
Invoke-RestMethod http://localhost:3001/api/health
curl.exe -i http://localhost:8080/api/turnos
docker compose exec frontend wget -qO- http://api:3000/health
docker compose exec cola rabbitmq-diagnostics -q ping
```

Resultados esperados: health con `status: ok`, turnos con 501 y `application/problem+json`, comunicación interna por `api` y broker disponible.

También se puede ejecutar la comprobación HTTP de todas las rutas, con Node.js 22 o posterior:

```powershell
node scripts/smoke.mjs
```

Para puertos diferentes: `node scripts/smoke.mjs http://localhost:3001 http://localhost:8080`, reemplazando las URLs.

## Checklist del avance

- [x] Un servicio por contenedor del C4: frontend, API, base y cola.
- [x] Contrato OpenAPI de colonia y Swagger UI.
- [x] Base sin puerto publicado, con volumen con nombre y healthcheck.
- [x] Comunicación entre servicios por nombre.
- [x] Configuración mediante variables de entorno y secretos en `.env` ignorado.
- [x] Arranque documentado con `docker compose up -d --build`.

La guía original se conserva en `docs/clase10-original.md`. El BFF mobile del ejemplo no forma parte del Compose de colonia; su código se conserva como referencia en `docs/template-bff-mobile/`.

