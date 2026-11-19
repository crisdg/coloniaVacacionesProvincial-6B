# ADR-002: Ingestión asincrónica mediante cola de mensajes

- **Estado:** Aceptado.
- **Fuente:** Documento del escenario 6B, ADR-002.

## Contexto

Las inscripciones abren a las 9 y los cupos se agotan en menos de una hora. El sistema del año anterior cayó a los cinco minutos. El escenario exige absorber un pico de demanda de unas 200.000 familias y preservar la equidad en la asignación.

Resolver toda la inscripción dentro del pedido HTTP acoplaría el tiempo de respuesta a la validación del padrón, cuyo límite es de 50 consultas por segundo. Una dependencia lenta acumularía pedidos abiertos y propagaría la espera hacia los clientes.

## Decisión

Separar la recepción durable de la solicitud de su validación y resolución mediante una cola de mensajes. La aceptación inicial indica que el sistema recibió la solicitud; no confirma una plaza.

En el proyecto, la API guarda la inscripción, su orden de recepción y un registro de salida pendiente en una misma transacción de PostgreSQL. Luego responde `202 Accepted`, con estado `pendiente_de_validacion` y un encabezado `Location` para consultar el resultado. La bandeja de salida transaccional (outbox) permite publicar posteriormente en RabbitMQ sin perder el trabajo si el broker está caído.

El procesamiento valida la residencia y asigna el cupo utilizando el orden persistido y coordinación transaccional por turno. La entrega o finalización de mensajes puede ocurrir fuera de orden: la cola por sí sola no garantiza la equidad. Una solicitud posterior no adelanta a una anterior del mismo turno cuya residencia todavía se desconoce.

## Alternativas evaluadas

- **Procesamiento sincrónico completo:** descartado por el acoplamiento al padrón y el riesgo de saturación durante la apertura.
- **Sala de espera virtual en el borde:** registrada separadamente como [ADR-002 (opción)](ADR-002-opcion-cola-de-espera-virtual.md), con estado rechazado en el documento fuente.

## Consecuencias

- Reduce el tiempo durante el cual el cliente espera por una validación externa y permite acumular trabajo pendiente.
- Conserva solicitudes aceptadas ante una caída del broker durante la ejecución, mientras la API y PostgreSQL sigan disponibles.
- Requiere consultar el estado final y presentar estados pendientes en la interfaz.
- Agrega operación de RabbitMQ, publicación confirmada, tratamiento de reentregas y reintentos. No se presupone una entrega exactamente una vez.
- La admisión sigue dependiendo de PostgreSQL: una base lenta o caída afecta el pedido inicial. La cola no elimina ese límite.
- Priorizar equidad puede demorar confirmaciones de todo un turno si su primera validación permanece sin resolver; otros turnos pueden avanzar.

## Atributos de calidad

Favorece la disponibilidad ante fallas del padrón o broker y permite desacoplar recepción y resolución. La equidad se sostiene mediante el orden durable y los bloqueos del turno. Aumenta la complejidad operativa y el tiempo hasta obtener un resultado definitivo.

## Implementación y referencias

- [Admisión](../../api/src/modules/inscripciones/routes.js), [outbox](../../api/src/modules/inscripciones/outbox.js), [cola](../../api/src/modules/inscripciones/cola.js) y [consumidor](../../api/src/modules/inscripciones/consumidor.js).
- [Asignación de cupos](../../api/src/modules/inscripciones/asignacion.js): prioridad por turno según `orden_recepcion`, que no representa la posición actual en lista de espera ni el instante del clic en el navegador.
- [Pruebas de equidad](../../api/test/equidad.test.mjs) y [pruebas de outbox](../../api/test/outbox.test.mjs).
- [ADR-004](ADR-004-control-de-tasa-padron.md): límite global del procesamiento contra el padrón.

La capacidad para absorber el pico y la elasticidad quedan pendientes de medición. El Compose actual espera un broker sano al arrancar la API; tolerar su caída posterior no implica poder iniciar todo el entorno sin RabbitMQ.
