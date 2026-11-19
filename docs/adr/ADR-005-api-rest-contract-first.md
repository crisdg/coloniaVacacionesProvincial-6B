# ADR-005: Diseño de API REST con enfoque Contract-First

- **Estado:** Aceptado.
- **Fuente:** Documento del escenario 6B, ADR-005.

## Contexto

El sistema expone operaciones de turnos e inscripciones para clientes como una aplicación web que corre en el navegador. Los consumidores necesitan un contrato estable que describa datos, operaciones, autenticación y resultados sin depender de la estructura interna del código.

## Decisión

Adoptar el enfoque **Contract-First** con OpenAPI: acordar el contrato antes de implementar una operación o modificar su comportamiento, y mantener la implementación alineada con ese contrato.

El archivo `openapi.yaml` constituye la referencia de la API HTTP. Debe describir recursos, parámetros, esquemas de entrada y salida, códigos de respuesta y requisitos de seguridad. Swagger UI permite explorar y ejecutar las operaciones usando ese contrato.

La aceptación asincrónica forma parte de la interfaz pública: `POST /inscripciones` responde `202 Accepted` y ofrece una ubicación para consultar el resultado, sin prometer una plaza en la respuesta inicial.

## Alternativas evaluadas

- **Code-First:** descartado porque obtener el contrato una vez implementada la API favorece que la interfaz refleje la organización interna del código, en lugar de las necesidades de sus consumidores.

## Consecuencias

- Obliga a definir la API desde la perspectiva del cliente y explicitar respuestas y errores.
- Permite que frontend y backend trabajen en paralelo contra un contrato acordado y, cuando se disponga de él, un mock.
- Facilita la revisión y comunicación de cambios de interfaz.
- Requiere mantener sincronizados contrato, implementación y clientes. Disponer de OpenAPI no garantiza automáticamente esa correspondencia.

## Atributos de calidad

Favorece la integración y el tiempo de entrega. Requiere disciplina de mantenimiento y verificación de compatibilidad al cambiar la API.

## Implementación y referencias

- [Contrato OpenAPI](../../openapi.yaml).
- [Configuración de Swagger UI](../../swagger/default.conf.template) y [anexo de autenticación](../../docker-compose.auth.yml).
- [Rutas de inscripciones](../../api/src/modules/inscripciones/routes.js) y [rutas de turnos](../../api/src/modules/inscripciones/turnos.routes.js).
- [Pruebas de API](../../api/test/api.test.mjs).
- [ADR-002](ADR-002-ingestion-asincronica.md): semántica asincrónica de admisión.
- [ADR-003](ADR-003-autenticacion-oidc-rbac.md): autenticación y autorización de los consumidores.
