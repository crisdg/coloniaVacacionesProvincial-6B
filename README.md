# Colonia de Vacaciones Provincial

Proyecto de Arquitectura de Software 1 · UNAHUR · Escenario 6B.

Aplicación para gestionar la inscripción de chicos a una colonia de vacaciones provincial. Los tutores consultan turnos, solicitan inscripciones y siguen su estado. Los administradores crean turnos, definen cupos y períodos de inscripción, y consultan, corrigen o cancelan solicitudes.

La recepción es asincrónica: la API guarda la solicitud y responde `202 Accepted`; luego valida la residencia mediante un padrón simulado y asigna las plazas según el orden de admisión de cada turno. Si no hay cupo, la inscripción queda en lista de espera. La integración limita globalmente las consultas al padrón a un máximo de 50 inicios por segundo.

El escenario plantea 40.000 cupos en 80 sedes y unas 200.000 familias. Esa es la escala objetivo del ejercicio; el entorno local no demuestra capacidad ni elasticidad para esa demanda. Keycloak funciona en modo desarrollo y el padrón es simulado.

## Tecnologías y organización

El backend es un **monolito modular** con un único módulo de negocio, `Inscripciones`, que incluye la entidad `Turno`.

- **Frontend:** React 19, TypeScript, Vite y Tailwind CSS; Nginx sirve la aplicación y reenvía las llamadas a la API.
- **API:** Node.js 22 y Express 5, con migraciones SQL automáticas.
- **Persistencia:** PostgreSQL 16.
- **Procesamiento asincrónico:** RabbitMQ 4 y outbox transaccional en PostgreSQL.
- **Identidad:** Keycloak 26.2.5, OIDC y Authorization Code con PKCE.
- **Gateway:** Express y `jose`; valida tokens y permisos por rol antes de reenviar a la API.
- **Contrato:** OpenAPI 3.0.3 y Swagger UI.
- **Ejecución local:** Docker Compose.

El navegador accede al frontend o a Swagger. Ambos reenvían `/api/` al gateway; este se comunica con la API por la red de Docker. La API, PostgreSQL y RabbitMQ no publican puertos al host. La configuración completa requiere los **dos archivos Compose** incluidos en los comandos de esta guía.

## Requisitos

- [Git](https://git-scm.com/downloads) para clonar el repositorio; también se puede descargar y descomprimir su ZIP.
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) iniciado y configurado para contenedores Linux. En Windows, completar su instalación con WSL 2 cuando lo solicite. En Linux también se puede usar Docker Engine con el plugin Compose.
- Docker Compose **2.24 o posterior**, con soporte para `!reset`.
- Acceso a Internet durante la primera construcción para descargar imágenes y dependencias.
- Puertos locales **3001, 8000, 8080 y 8180** disponibles.
- Un navegador actualizado.

Los ejemplos usan **PowerShell** y se ejecutan desde la raíz del repositorio. No hace falta instalar Node.js, PostgreSQL, RabbitMQ ni Keycloak en la máquina para levantar la aplicación con Docker. Node.js 22 o posterior es opcional para ejecutar las verificaciones locales indicadas más adelante.

Comprobar la instalación:

```powershell
git --version
docker --version
docker compose version
docker info
```

Si `docker info` no puede conectarse al motor, iniciar Docker Desktop y esperar a que esté listo antes de continuar.

## Levantar el proyecto

### 1. Obtener el código

```powershell
git clone https://github.com/crisdg/coloniaVacacionesProvincial-6B.git
cd coloniaVacacionesProvincial-6B
```

Si ya se descargó el proyecto, abrir una terminal en la carpeta que contiene `docker-compose.yml`, `docker-compose.auth.yml` y `.env.example`.

### 2. Crear la configuración local

Crear `.env` sin reemplazar uno existente:

```powershell
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item .env.example .env
}
```

Abrir `.env` con un editor de texto. En Windows:

```powershell
notepad .env
```

Completar con valores propios las tres contraseñas que vienen vacías:

```dotenv
POSTGRES_DB=colonia
POSTGRES_USER=colonia
POSTGRES_PASSWORD=REEMPLAZAR_POR_UNA_CLAVE_LOCAL
RABBITMQ_USER=colonia
RABBITMQ_PASSWORD=REEMPLAZAR_POR_OTRA_CLAVE_LOCAL
KC_ADMIN_USERNAME=admin
KC_ADMIN_PASSWORD=REEMPLAZAR_POR_UNA_CLAVE_DE_ADMIN
FRONTEND_PORT=3001
SWAGGER_PORT=8080
```

Reemplazar los textos `REEMPLAZAR_...` antes de continuar. `.env` está excluido de Git. Para esta instalación, mantener los nombres de base y usuario y los puertos predeterminados. Los clientes OIDC tienen redirecciones registradas para `localhost:3001` y `localhost:8080`: cambiar solo el puerto en `.env` rompe el inicio de sesión.

Las variables `POSTGRES_*` configuran la base, `RABBITMQ_*` el broker y `KC_ADMIN_*` la cuenta de administración de Keycloak. Esta última es distinta de los usuarios de la aplicación.

### 3. Validar y construir

Validar la configuración sin imprimir los valores de las contraseñas:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml config --quiet
```

Si termina sin errores, construir y levantar todos los servicios:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml up -d --build --wait --wait-timeout 180
```

La primera ejecución descarga imágenes e instala dependencias dentro de los contenedores. No requiere ejecutar `npm install` en el host. En equipos lentos, si vence la espera, revisar los logs y volver a comprobar el estado; el timeout no elimina los contenedores.

Durante el primer arranque se crean los volúmenes, se aplican las migraciones pendientes y se importa el realm `colonia` en Keycloak. Las migraciones cargan la convocatoria `verano-2027` y tres sedes: Polideportivo Central (1), Parque Municipal (2) y Club Social Norte (3). **No se crean turnos ni inscripciones de ejemplo**; el primer turno se crea en el recorrido de prueba de esta guía.

### 4. Verificar el arranque

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml ps
Invoke-RestMethod http://localhost:3001/api/health
```

`db`, `cola`, `api` y `keycloak` deben figurar como `healthy`. `frontend`, `gateway` y `swagger-ui` deben estar en ejecución. El endpoint de salud debe devolver:

```json
{
  "status": "ok",
  "database": "ok"
}
```

Este endpoint verifica API y PostgreSQL; no comprueba el progreso de la cola ni la disponibilidad de todas las dependencias. Para revisar el broker:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml exec cola rabbitmq-diagnostics -q ping
```

## Accesos y usuarios

- [Aplicación web](http://localhost:3001/): ingreso y pantalla del tutor.
- [Swagger UI](http://localhost:8080/): exploración de la API y operaciones administrativas.
- [Consola de Keycloak](http://localhost:8180/admin/): administración de usuarios y roles.
- [Salud de la API por el gateway](http://localhost:8000/health): comprobación pública.

Usuarios de demostración importados con el realm:

- **Administrador de la aplicación:** usuario `ana`, contraseña `ana123`. Gestiona turnos, cupos e inscripciones mediante la API/Swagger.
- **Tutor:** usuario `beto`, contraseña `beto123`. Consulta turnos, solicita inscripciones y consulta las propias desde el frontend o Swagger.
- **Administrador de Keycloak:** usuario indicado en `KC_ADMIN_USERNAME` (por defecto `admin`) y contraseña `KC_ADMIN_PASSWORD` de `.env`. Administra la identidad; no es la cuenta `ana`.

Las credenciales `ana` y `beto` son exclusivamente datos de demostración. El frontend actual contiene la pantalla del tutor; la administración del dominio se realiza desde Swagger. El autorregistro no está habilitado.

## Probar una inscripción de principio a fin

### 1. Crear un turno como administrador

Abrir [Swagger UI](http://localhost:8080/) y pulsar **Authorize**. Usar el cliente `swagger-ui`, dejar `client_secret` vacío, seleccionar los scopes `openid` y `profile`, e iniciar sesión con `ana` / `ana123`.

Generar un cuerpo de ejemplo con fechas relativas al día de la prueba para que la inscripción esté abierta:

```powershell
$ahoraDemo = [DateTimeOffset]::Now
@{
    convocatoriaId = 'verano-2027'
    sedeId = 1
    nombre = 'Turno de demostración'
    fechaInicio = $ahoraDemo.AddDays(10).ToString('yyyy-MM-dd')
    fechaFin = $ahoraDemo.AddDays(20).ToString('yyyy-MM-dd')
    inscripcionAbreEn = $ahoraDemo.AddDays(-1).ToString('o')
    inscripcionCierraEn = $ahoraDemo.AddDays(2).ToString('o')
    cupoTotal = 2
} | ConvertTo-Json
```

Copiar el JSON que imprime la terminal en **POST /turnos → Try it out**, y pulsar **Execute**. Debe responder `201 Created`. Guardar el `id` devuelto. La apertura debe ser anterior al momento actual y el cierre posterior; el cierre también debe ser anterior o igual al inicio de la actividad.

### 2. Inscribir a un chico como tutor

Abrir [la aplicación](http://localhost:3001/) en una ventana privada o en otro perfil del navegador, para no reutilizar la sesión de `ana`. Pulsar **Ingresar** e iniciar sesión con `beto` / `beto123`.

Seleccionar el turno recién creado y completar los datos del chico con datos de prueba:

- DNI de 7 u 8 dígitos, sin puntos; por ejemplo, `45678901` si todavía no se usó en la convocatoria.
- Nombre y apellido no vacíos.
- Fecha de nacimiento que corresponda a una edad de **6 a 12 años inclusive en el momento de inscripción**. Por ejemplo, una fecha de hace ocho años.

Enviar la solicitud. La aceptación inicial devuelve `202 Accepted` y estado `pendiente_de_validacion`; todavía no confirma una plaza. Consultar o actualizar el listado de inscripciones para observar el resultado del procesamiento.

### 3. Comprobar los resultados

Con el padrón simulado y cupo disponible, el DNI del ejemplo debe terminar con una inscripción `confirmada`. Para explorar otros casos:

- Un DNI terminado en `0` se considera no residente y la inscripción termina `rechazada`.
- Al agotarse las plazas, las solicitudes elegibles quedan `en_lista_de_espera`.
- Aumentar `cupoTotal` mediante `PATCH /turnos/{id}` o cancelar una confirmada mediante `POST /inscripciones/{id}/cancelaciones` permite continuar la asignación en orden. Estas operaciones requieren `ana`; la cancelación exige un `motivo`.
- Reutilizar un DNI con una inscripción activa en la misma convocatoria devuelve `409`, aunque cambie el turno o el tutor.

La edad se calcula con la fecha de Argentina. La prioridad depende del orden durable de admisión por turno, no del momento del clic ni del orden de respuesta del padrón. Una validación pendiente anterior puede demorar las confirmaciones posteriores de ese turno.

## API y autenticación

El contrato completo está en [openapi.yaml](openapi.yaml). Las principales operaciones son:

- `GET /turnos` y `GET /turnos/{id}`: consulta de turnos para ambos roles.
- `POST /turnos` y `PATCH /turnos/{id}`: gestión de turnos por el administrador.
- `POST /inscripciones`: solicitud de inscripción por el tutor.
- `GET /inscripciones` y `GET /inscripciones/{id}`: el tutor consulta las propias; el administrador puede consultar todas.
- `PATCH /inscripciones/{id}`: corrección administrativa de datos del chico.
- `POST /inscripciones/{id}/cancelaciones`: cancelación administrativa con motivo.

Desde frontend o Swagger, las rutas llevan el prefijo `/api`, por ejemplo `http://localhost:3001/api/turnos`. Desde el gateway directo se usa `http://localhost:8000/turnos`. Las operaciones protegidas requieren `Authorization: Bearer <access_token>`.

La API responde `401` ante autenticación inválida, `403` ante permisos insuficientes y `404` cuando un tutor intenta consultar una inscripción ajena. `POST /inscripciones` admite `Idempotency-Key`: repetir la misma clave y contenido con el mismo tutor recupera la aceptación original. El detalle está en la [referencia técnica](docs/implementacion.md).

## Pruebas

Con Node.js 22 o posterior instalado, ejecutar desde la raíz las pruebas que no necesitan servicios externos ni instalar paquetes:

```powershell
node --test scripts/architecture.test.mjs
node --test api/test/padron.test.mjs api/test/padron-reintentos.test.mjs
```

Con el entorno Docker levantado, verificar páginas, salud, rutas y rechazo de pedidos sin autenticación:

```powershell
node scripts/smoke.mjs
```

Para las pruebas de contrato, ejecutar dentro de Docker:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml run --rm --no-deps -v ./api/test:/app/test:ro api node --test test/api.test.mjs
```

Las pruebas de contrato crean datos en la base local. La [guía completa de pruebas](docs/pruebas.md) documenta las suites de equidad, asignación, ventana del padrón, outbox, consumidor y gateway, junto con sus requisitos y efectos sobre los datos.

[prueba-k6.js](prueba-k6.js) contiene una calibración local de carga, no una validación de la escala provincial. Requiere k6, un token vigente de tutor, un turno abierto y un destino accesible; además, hay que revisar la edad del chico de prueba y posibles DNIs usados en ejecuciones anteriores.

## Detener, volver a iniciar y actualizar

Detener y eliminar contenedores y redes **conservando los datos**:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml down
```

Volver a levantar el entorno o reconstruir después de cambios en el código:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml up -d --build --wait --wait-timeout 180
```

Las imágenes copian el código al construir: guardar un archivo local no actualiza automáticamente los contenedores. Las migraciones nuevas se aplican al arrancar la API; las ya registradas no se repiten.

Los datos persisten en los volúmenes de PostgreSQL, RabbitMQ y Keycloak del proyecto Compose `colonia-vacaciones`. Cambiar una contraseña en `.env` no cambia automáticamente las credenciales ya inicializadas en esos servicios. Del mismo modo, editar el JSON del realm no reemplaza uno ya importado.

### Reiniciar todos los datos de demostración

**Esta operación elimina la base, las inscripciones, los mensajes y los usuarios/configuración persistidos en Keycloak.** Usarla solo cuando se quiera descartar todo el entorno local y comenzar otra vez:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml down --volumes
docker compose -f docker-compose.yml -f docker-compose.auth.yml up -d --build --wait --wait-timeout 180
```

El archivo `.env` se conserva. Se vuelven a aplicar las migraciones y a importar los usuarios del realm; habrá que crear nuevamente los turnos.

## Solución de problemas

Para observar el estado y los últimos mensajes:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml ps -a
docker compose -f docker-compose.yml -f docker-compose.auth.yml logs --tail=100 api gateway keycloak cola
```

Para seguir un servicio en vivo, por ejemplo la API:

```powershell
docker compose -f docker-compose.yml -f docker-compose.auth.yml logs -f api
```

`Ctrl+C` termina el seguimiento de logs sin detener los contenedores.

- **No se puede conectar al motor de Docker:** comprobar que Docker Desktop esté iniciado, use contenedores Linux y que `docker info` funcione en esa terminal.
- **Error de variable obligatoria:** verificar que exista `.env` en la raíz y que las tres contraseñas estén completas. Repetir `config --quiet`.
- **Error con `!reset`:** actualizar Docker Compose a una versión compatible y usar `docker compose`, sin el guion del comando antiguo `docker-compose`.
- **Puerto ocupado:** detener la aplicación que ocupa 3001, 8000, 8080 o 8180. Cambiar puertos requiere ajustar también redirecciones, orígenes y URLs OIDC; la guía utiliza los predeterminados.
- **`502` o servicios no saludables:** revisar los logs y esperar la inicialización. Confirmar que se usaron ambos archivos Compose.
- **Login con error de redirección:** entrar por `http://localhost:3001/` o `http://localhost:8080/`, sin sustituir `localhost` por `127.0.0.1`. El callback de Swagger es `http://localhost:8080/oauth2-redirect.html`.
- **`401` después de unos minutos:** volver a iniciar sesión o autorizar en Swagger; los access tokens del realm duran cinco minutos.
- **`403` al crear un turno:** usar `ana`; el rol tutor no permite esa operación. Para cambiar de usuario sin reutilizar la sesión OIDC, usar una ventana privada separada.
- **No aparecen turnos disponibles:** crear uno como administrador y revisar que su período de inscripción esté abierto.
- **`400` al crear un turno o inscripción:** revisar fechas, campos obligatorios, edad y formato del DNI según OpenAPI.
- **`409` al inscribir:** revisar si ya existe una inscripción activa del mismo DNI en `verano-2027`, si cerró el período o si se reutilizó una clave idempotente con otro contenido.
- **La inscripción permanece pendiente:** revisar API y RabbitMQ. Una falla técnica del padrón mantiene la solicitud pendiente para reintentar; una solicitud anterior del mismo turno también puede demorar la asignación.
- **Las credenciales o el realm no cambian:** los volúmenes conservan su configuración inicial. Actualizarla desde el servicio correspondiente o, si los datos son descartables, realizar el reinicio completo documentado arriba.

## Estructura y documentación

- [api/](api/): API, módulo de Inscripciones, migraciones y pruebas.
- [frontend/](frontend/): aplicación del tutor y cliente OIDC.
- [auth/gateway/](auth/gateway/): validación JWT y autorización por roles.
- [auth/keycloak/](auth/keycloak/): realm, clientes y usuarios de demostración.
- [db/](db/): inicialización del esquema de PostgreSQL.
- [scripts/](scripts/): comprobación HTTP y reglas de arquitectura.
- [openapi.yaml](openapi.yaml): contrato de la API.
- [Índice de documentación y ADR](docs/README.md).
- [Escenarios de calidad y análisis ATAM](docs/escenarios-de-calidad-y-atam.md).
- [Referencia técnica de la implementación](docs/implementacion.md).
- [Guía de pruebas](docs/pruebas.md).

La [guía de clase original](docs/clase10-original.md) y el [template BFF mobile](docs/template-bff-mobile/) se conservan como material de referencia; el BFF no forma parte de la aplicación de colonia.
