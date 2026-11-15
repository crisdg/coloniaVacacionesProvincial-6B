# ADR-007: Dónde y qué se valida del token

* **Estado:** Aceptado
* **Complementa:** ADR-003 del escenario 6B (autenticación delegada en OIDC y autorización RBAC). No reemplaza al ADR-001 (monolito modular) ni al ADR-006 (secretos fuera del Compose).

## Contexto

El escenario define dos roles: tutor, que consulta turnos e inscribe, y administrador, que gestiona turnos, cupos e inscripciones. ADR-003 delega el login en un proveedor OIDC. Keycloak emite el token; hace falta una decisión explícita sobre quién lo controla y qué campos se aceptan.

La API es un solo módulo de negocio dentro del monolito. No hay un servicio que llame a otro sin usuario, así que no hay cliente confidencial ni `client_secret`.

## Decisión

El token se valida **solo en el gateway**. La API no vuelve a validarlo: no publica puerto y solo la alcanza la red interna de Compose.

En cada pedido protegido el gateway comprueba:

* **Firma**, con las claves públicas (JWKS) del realm `colonia`.
* **`iss`**, que sea `http://localhost:8180/realms/colonia`, la URL que vio el navegador.
* **`aud`**, que incluya `api-colonia`.
* **`exp`**, que no esté vencido.

Si eso falla, responde **401** con Problem Details. Si el token es válido pero el rol del realm no alcanza para la operación, responde **403** con Problem Details. `GET /health` no exige token.

Los permisos están en el gateway, asignados al rol y no a la persona: tutor consulta turnos y solicita inscripciones; administrador gestiona turnos y corrige o cancela inscripciones.

## Alternativas evaluadas

* *Validar en cada módulo de la API.* Se descartó. Hay un solo despliegue (ADR-001) y repetir la verificación partiría la regla de seguridad.
* *Validar en el gateway y otra vez en la API.* Se descartó por el mismo motivo: dos lugares para que `iss` o `aud` se desalineen, sin una segunda puerta de entrada.
* *Login propio.* Ya descartado en ADR-003.

## Consecuencias

* **Ganancia:** Una sola puerta aplica firma, emisor, audiencia, vencimiento y rol. Swagger y el frontend llegan a la API solo a través del gateway.
* **Resignación:** Quien esté dentro de la red de Compose puede llamar a la API sin token. El puerto de la API no se publica en el host.
* **Identidad hacia la API:** el gateway arma de cero los headers del pedido reenviado y agrega `X-Usuario-Id` (el `sub` del token) y `X-Usuario-Roles`. Un `X-Usuario-*` que mande el cliente nunca llega a la API. La API usa esos headers para la titularidad, porque el gateway distingue roles pero no dueños: un tutor solo ve sus inscripciones.
