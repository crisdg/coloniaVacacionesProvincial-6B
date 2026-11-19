# Escenarios de calidad y análisis ATAM

Colonia de Vacaciones Provincial · Escenario 6B · Arquitectura de Software 1 · UNAHUR.

Este archivo reúne los cinco escenarios de calidad y el análisis ATAM del documento **Colonia de Vacaciones Provincial (Escenario 6B) (2).docx**. Se conservan las prioridades, las medidas propuestas y las verificaciones pendientes. Las medidas son criterios de evaluación, no resultados de pruebas ejecutadas.

## Escenarios de calidad

Se mantienen las etiquetas de prioridad `(A, A)` y `(A, M)` utilizadas en el documento fuente.

### E1. Recepción del pico y elasticidad (A, A)

- **Fuente:** Familias que presentan solicitudes válidas al abrir la inscripción.
- **Estímulo:** Escenario de carga propuesto de 200.000 pedidos `POST` únicos en 600 segundos.
- **Artefacto:** API de admisión, PostgreSQL y padrón externo.
- **Entorno:** Pico de inscripciones en la primera hora de apertura.
- **Respuesta:** Absorber el pico con una cola de mensajes y responder `202 Accepted`.
- **Medida propuesta:** Percentil 95 (p95) del tiempo de respuesta de los pedidos `POST` de extremo a extremo.
- **Verificación:** k6/JMeter con tasa de llegada abierta.
- **Estado:** Pendiente de medición de carga y de elasticidad.

El documento no establece un umbral numérico de aceptación para el p95.

### E2. Equidad bajo concurrencia (A, A)

- **Fuente:** Dos o más tutores que compiten por el mismo turno.
- **Estímulo:** Solicitudes concurrentes, respuestas del padrón fuera de orden, reintentos y cancelaciones.
- **Artefacto:** Admisión, secuencia `orden_recepcion`, asignador y tablas de turnos e inscripciones.
- **Entorno:** Pico de demanda, un cupo disponible y primera solicitud con validación lenta; otro turno debe poder avanzar.
- **Respuesta:** Preservar el orden durable de admisión del turno. Una respuesta rápida posterior no adelanta a una solicitud anterior aún pendiente. Los rechazos o las cancelaciones habilitan continuar.

**Medidas:**

- Cero adelantamientos respecto del orden definido.
- Cantidad de inscripciones confirmadas menor o igual a `cupo_total` en todo estado confirmado.
- Cero órdenes alterados por reintentos.

**Verificación:** Prueba controlada con una solicitud A admitida antes que B, la consulta al padrón de B terminando primero y la resolución o cancelación posterior de A. Se referencian las pruebas [equidad.test.mjs](../api/test/equidad.test.mjs), [asignacion.test.mjs](../api/test/asignacion.test.mjs) y [consumidor.test.mjs](../api/test/consumidor.test.mjs), además de la inspección de rutas y SQL.

**Alcance del orden:** El ámbito es por turno, aunque la secuencia sea global. Las solicitudes simultáneas se ordenan por la serialización de la admisión. La secuencia puede tener saltos y no representa la posición actual en espera.

**Trade-off:** Equidad frente a rapidez de confirmación. Una primera solicitud con residencia indefinida puede frenar las siguientes del mismo turno.

### E3. Continuidad ante dependencia caída (A, A)

- **Fuente:** Padrón o broker no disponible después del arranque.
- **Estímulo:** Caída controlada de cinco minutos y posterior restauración.
- **Artefacto:** API, outbox, consumidor, reintentos y monitoreo propuesto.
- **Entorno:** API y PostgreSQL sanos, con una carga de recepción por debajo de su capacidad medida. Ensayo aislado, sin datos reales.
- **Respuesta:** Continuar admitiendo solicitudes cuando solo falla el padrón o el broker, conservar las solicitudes pendientes y su orden, y reintentar al volver la dependencia. Una falla técnica no significa «no residente».

**Medidas propuestas:**

- Cero pérdidas de solicitudes que recibieron `202 Accepted`.
- Cero rechazos de residencia causados por timeout.
- Detección operativa en un tiempo menor o igual a 60 segundos.
- Al recuperar la dependencia, progreso observable y vaciado acorde con el trabajo pendiente acumulado y la tasa efectiva medida.
- Para un único caso elegible, sin trabajo pendiente acumulado y con el padrón sano, ensayo de recuperación en un tiempo menor o igual a 120 segundos.

**Verificación:** Pruebas existentes de fallas y reentregas, más un experimento integral de caída y restauración que permanece pendiente.

**Parámetros consignados en el documento:**

- Timeout externo: 10 segundos.
- Límite del intento del consumidor: 30 segundos.
- Duración de la reclamación: 60 segundos, con renovación cada 20 segundos.
- Espera progresiva entre reintentos (backoff): de 1 a 60 segundos, respetando una espera mayor si la saturación la indica.

**Límites:** `GET /health` comprueba la API y PostgreSQL; no mide el atraso del outbox ni el progreso de la cola. Compose espera un broker sano para iniciar la API desde cero: tolerar una caída durante la ejecución no implica arrancar sin broker. El monolito comparte recursos entre recepción y procesamiento.

### E4. Acceso autorizado y privacidad (A, M)

- **Fuente:** Usuario sin token, tutor con rol insuficiente o tutor que intenta leer una inscripción ajena.
- **Estímulo:** Invocar operaciones protegidas, modificar cupos o falsificar encabezados de identidad.
- **Artefacto:** Gateway, proveedor OIDC y controles de titularidad de la API.
- **Entorno:** Ingreso por la puerta pública prevista; tokens válidos, vencidos, de audiencia o emisor incorrectos, y solicitudes con encabezados manipulados.
- **Respuesta:** Validar JWT y rol, ignorar la identidad enviada por el cliente y limitar el acceso a los recursos propios.

**Medidas:**

- Denegar el 100 % de los casos de la matriz que deben rechazarse.
- Responder `401` ante autenticación inválida.
- Responder `403` ante un rol insuficiente.
- Responder `404` ante el intento de consultar una inscripción ajena.
- Cero escrituras o exposición de datos en los casos denegados.

**Verificación:** Pruebas HTTP a través del gateway para JWT y encabezados; [api.test.mjs](../api/test/api.test.mjs) para titularidad.

### E5. Integración con padrón (A, M)

- **Fuente:** Módulo de Inscripciones al validar la residencia de una solicitud o de una corrección de DNI, incluidos los reintentos.
- **Estímulo:** Necesidad de consultar el padrón provincial cuando la demanda de consultas puede superar las 50 por segundo.
- **Artefacto:** Integración con el padrón.
- **Entorno:** Operación normal o pico de inscripciones, con una o varias réplicas de la API.
- **Respuesta:** No iniciar más de 50 consultas al padrón en cualquier intervalo de un segundo. Las que exceden el tope esperan un permiso. La espera o una falla técnica no se interpretan como «no reside»: la inscripción sigue pendiente de validación.
- **Medida:** Como máximo 50 inicios de consulta en cualquier intervalo de un segundo, sumando todas las réplicas y los reintentos, incluidas las consultas por correcciones de DNI indicadas en la fuente del estímulo.

El documento no especifica un procedimiento de verificación separado para E5.

## Análisis ATAM

El análisis ATAM desarrollado en el documento corresponde a **E1: Recepción del pico y elasticidad (A, A)**. No se presentan recorridos ATAM adicionales para E2 a E5.

### Escenario analizado

Pico de inscripciones durante la apertura.

### Recorrido de E1

1. Las solicitudes pasan por el gateway. La API valida y guarda la solicitud, su prioridad y el trabajo pendiente.
2. La respuesta `202 Accepted` permite terminar esa interacción sin esperar al padrón. La admisión sigue dependiendo de PostgreSQL y de los bloqueos del turno.
3. El outbox publica el trabajo y el consumidor consulta el padrón al ritmo permitido.
4. El asignador usa el orden guardado, aunque las validaciones terminen desordenadas.
5. Si la llegada supera la resolución, aumenta el trabajo pendiente. El sistema puede recibir solicitudes rápido y tardar mucho en confirmarlas.

### Punto de sensibilidad

**Timeout y espera entre reintentos:** Un timeout corto genera repeticiones; una espera larga demora la recuperación.

### Trade-off

- **Decisión:** Responder `202 Accepted` y validar después.
- **Ganancia:** Respuesta inicial más rápida y continuidad ante un padrón lento.
- **Costo:** El resultado final no es inmediato; se necesita consultar el estado.

### Riesgo

**Dependencia externa:** La integración con el padrón externo puede causar demoras en la cola si no se limita la tasa de trabajo.

### No riesgo

**Prioridad y cupo:** El asignador usa el orden persistido y coordinación por turno; no depende de que RabbitMQ entregue o termine de procesar en orden.

Esta clasificación corresponde al análisis del documento y al mecanismo descrito; no constituye una garantía general sobre cualquier carga o configuración.

### Tema de riesgo

**Dependencia externa por validar:** No se probó la capacidad contra el padrón real.
