# Documentación de arquitectura

Los registros de decisiones de arquitectura (ADR) documentan el contexto, la decisión, las alternativas y sus consecuencias para la Colonia de Vacaciones Provincial, escenario 6B.

La fuente es el documento **Colonia de Vacaciones Provincial (Escenario 6B) (2).docx**, sección «Registro de Decisiones de Arquitectura (ADRs)». Se conservan los estados de esa propuesta. Las secciones de implementación distinguen la decisión documentada de su realización en el repositorio; no acreditan resultados de carga ni capacidad en producción.

## Registros

Los [escenarios de calidad y el análisis ATAM](escenarios-de-calidad-y-atam.md) reúnen E1 a E5 y la evaluación de E1 desarrollada en el documento fuente.

Para instalar y ejecutar el sistema, consultar el [README principal](../README.md). El detalle de funcionamiento está en la [referencia técnica](implementacion.md), y los comandos de verificación en la [guía de pruebas](pruebas.md).

- [ADR-001: Estilo arquitectónico monolito modular](adr/ADR-001-monolito-modular.md) — Aceptado.
- [ADR-002: Ingestión asincrónica mediante cola de mensajes](adr/ADR-002-ingestion-asincronica.md) — Aceptado.
- [ADR-002 (opción): Cola de espera virtual en la capa de borde](adr/ADR-002-opcion-cola-de-espera-virtual.md) — Rechazado.
- [ADR-003: Autenticación delegada OIDC y autorización RBAC](adr/ADR-003-autenticacion-oidc-rbac.md) — Aceptado.
- [ADR-004: Control de tasa para el padrón de residentes](adr/ADR-004-control-de-tasa-padron.md) — Propuesta en el documento; existe implementación en el repositorio.
- [ADR-005: Diseño de API REST con enfoque Contract-First](adr/ADR-005-api-rest-contract-first.md) — Aceptado.
- [ADR-007: Dónde y qué se valida del token](adr/ADR-007-validacion-del-token.md) — Aceptado; corresponde al ADR-006 del documento fuente.

## Correspondencia de numeración

La decisión de validación del token aparece como **ADR-006** en el documento fuente y como **ADR-007** en el registro que ya existía en este repositorio. Se conserva ADR-007 para mantener las referencias existentes y evitar duplicar la misma decisión.

El registro anterior también mencionaba un ADR-006 sobre secretos fuera de Compose, pero ese archivo no está presente y no corresponde al ADR-006 del documento recibido. Esa referencia se retira del ADR-007; no se crea una decisión nueva a partir de esa mención.

La sala de espera virtual conserva la identificación **ADR-002 (opción)** y su estado rechazado. Es una alternativa documentada, no una funcionalidad adoptada.
