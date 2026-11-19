# ADR-004: Control de tasa para el padrón de residentes

- **Estado:** Propuesta, según el documento fuente.
- **Fuente:** Documento del escenario 6B, ADR-004.
- **Situación en el repositorio:** Existe una implementación; se conserva el estado documental sin asumir una aprobación posterior.

## Contexto

La residencia en la jurisdicción debe validarse contra un padrón externo que admite como máximo 50 consultas por segundo. El pico de inscripciones supera ampliamente esa capacidad, por lo que aumentar consumidores no puede traducirse en llamadas ilimitadas al proveedor.

El límite debe contemplar todas las réplicas, los reintentos y las consultas por correcciones administrativas de DNI.

## Decisión propuesta

Regular la tasa de consultas al padrón para no superar 50 inicios de consulta en cualquier ventana móvil de un segundo. Las solicitudes que no obtengan permiso esperan; una falla técnica no se interpreta como una respuesta negativa de residencia.

La cola desacopla la recepción de solicitudes de esta restricción, como establece el [ADR-002](ADR-002-ingestion-asincronica.md).

## Alternativas evaluadas

- **Consulta sincrónica directa sin regulación:** descartada porque el pico agotaría inmediatamente el límite externo y pondría en riesgo la integración.

## Consecuencias

- Reduce el riesgo de superar la tasa permitida por el proveedor.
- La velocidad de resolución depende de esa tasa, aunque la aplicación pueda admitir solicitudes más rápido.
- Se acumulan pendientes cuando el ritmo de llegada supera el de validación.
- La regulación no elimina otros errores del padrón, indisponibilidad o rechazos de tasa externos; siguen siendo necesarios timeouts y reintentos.
- Coordinar el límite entre réplicas requiere estado compartido. En esta implementación, si PostgreSQL falla no se consulta sin permiso.

## Atributos de calidad

Favorece una integración controlada con el padrón y la continuidad del procesamiento. Limita el rendimiento de validación y aumenta el tiempo hasta confirmar una inscripción. El regulador no define la prioridad de cupos: esa responsabilidad pertenece al asignador por turno.

## Implementación y referencias

El repositorio utiliza [permisos globales en PostgreSQL](../../api/src/modules/inscripciones/padron-limite.js), coordinados con un bloqueo asesor transaccional. La espera y la consulta externa se realizan fuera del bloqueo.

La [configuración](../../api/src/modules/inscripciones/padron-config.js) admite un tope entero de 1 a 50, compartido por todas las réplicas. Cada permiso debe utilizarse antes de 100 ms y permanece contabilizado durante 1.100 ms para cubrir el desfase hasta el inicio de la consulta. Con un tope de 50, ese margen reduce el máximo teórico sostenido a aproximadamente 45,5 consultas por segundo.

El [cliente del padrón](../../api/src/modules/inscripciones/padron-cliente.js) descarta permisos tardíos y aplica el timeout externo. Los [reintentos](../../api/src/modules/inscripciones/padron-reintentos.js) y el [consumidor](../../api/src/modules/inscripciones/consumidor.js) conservan pendientes y su orden ante errores técnicos.

- [Pruebas del límite global](../../api/test/padron-limite.test.mjs).
- [Pruebas de reintentos](../../api/test/padron-reintentos.test.mjs).
- [Adaptador simulado](../../api/src/modules/inscripciones/padron-simulado.js).

La integración actual usa un simulador. La garantía local se refiere al inicio del adaptador; un futuro adaptador HTTP debe iniciar el envío sin agregar una cola interna. El comportamiento frente al padrón real y su política de tasa requiere validación adicional.
