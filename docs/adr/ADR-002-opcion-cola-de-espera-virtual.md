# ADR-002 (opción): Cola de espera virtual en la capa de borde

- **Estado:** Rechazado.
- **Fuente:** Documento del escenario 6B, ADR-002 (OPCIÓN).
- **Relacionado:** [ADR-002: Ingestión asincrónica](ADR-002-ingestion-asincronica.md).

## Contexto

La alternativa considera el acceso masivo de hasta 200.000 familias a las 9 para competir por 40.000 cupos. Si todo el tráfico alcanza simultáneamente la aplicación y la base de datos, puede saturar sus recursos y el pool de conexiones.

## Decisión

No adoptar esta alternativa en la propuesta documentada. El documento la marca como **Rechazado**, aunque describe su funcionamiento con la expresión «Implementar una Cola de Espera Virtual».

La opción evaluada consiste en ubicar una sala de espera en la capa de borde, mediante un servicio como Cloudflare Waiting Room o un balanceador con esa capacidad. El borde retendría los accesos que excedan la capacidad segura y liberaría tráfico gradualmente hacia el monolito.

El documento no explicita el motivo del rechazo. No se atribuye una justificación adicional ni se incorpora la sala de espera como parte de la arquitectura vigente.

## Alternativas evaluadas

- **Acceso HTTP directo sin sala de espera:** la evaluación de esta opción señala el riesgo de saturación y errores durante el pico.
- **Ingestión asincrónica:** es la decisión aceptada en el ADR-002. Regula el procesamiento posterior a la admisión; no equivale a controlar el ingreso de tráfico en el borde.

## Consecuencias de la opción evaluada

- Podría proteger recursos de la aplicación y la base al dosificar el tráfico admitido.
- Permitiría informar una posición en la fila, si el servicio elegido soportara esa semántica.
- Introduciría una espera antes de acceder al formulario de inscripción y una dependencia operativa adicional en el borde.
- La equidad de esa fila y su correspondencia con el orden de admisión del backend requerirían definición y verificación; no se obtienen automáticamente por agregar una sala de espera.

## Atributos de calidad

La opción busca disponibilidad y control del pico a cambio de mayor espera de acceso y complejidad de infraestructura. Al estar rechazada, estos beneficios no se atribuyen al sistema implementado.

## Implementación y referencias

No hay una sala de espera virtual configurada en [Docker Compose](../../docker-compose.yml) ni en el [anexo de autenticación](../../docker-compose.auth.yml). El mecanismo adoptado se documenta en el [ADR-002](ADR-002-ingestion-asincronica.md).
