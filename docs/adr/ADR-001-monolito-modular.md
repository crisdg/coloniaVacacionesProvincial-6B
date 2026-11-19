# ADR-001: Estilo arquitectónico monolito modular

- **Estado:** Aceptado.
- **Fuente:** Documento del escenario 6B, ADR-001.

## Contexto

El programa provincial ofrece 40.000 cupos en 80 sedes para unas 200.000 familias. La inscripción concentra la demanda en la apertura y el uso durante el resto del año es bajo. La infraestructura prevista es una nube con pago por uso y el mantenimiento queda a cargo de un equipo de ocho personas.

Se necesita organizar el dominio de forma mantenible sin introducir una carga operativa desproporcionada. La matriz de Pugh del documento compara monolito en capas, monolito modular y microservicios; obtiene puntuaciones totales de 0, 3 y -1, respectivamente.

## Decisión

Adoptar un monolito modular: organizar la lógica de negocio en módulos con responsabilidades delimitadas e interfaces explícitas, desplegados como una sola unidad de aplicación.

En el alcance actual existe un único módulo de negocio, **Inscripciones**. **Turno** es una entidad de ese módulo y no un servicio independiente. PostgreSQL, RabbitMQ, Keycloak y el gateway cumplen funciones de infraestructura o acceso; su presencia no convierte el dominio en microservicios.

## Alternativas evaluadas

- **Microservicios:** descartados por la complejidad operativa y el costo inicial para el equipo disponible, aunque permitan escalar servicios de forma independiente.
- **Monolito en capas:** descartado frente a la mejor puntuación del monolito modular en mantenibilidad y tiempo de entrega en la evaluación del escenario.

## Consecuencias

- Facilita las pruebas y la refactorización, y evita llamadas de red entre módulos de negocio.
- Permite mantener límites internos sin administrar despliegues independientes para cada responsabilidad.
- El escalado replica la unidad completa; no permite aumentar de forma independiente los recursos de admisión y procesamiento de inscripciones.
- La elección del estilo no demuestra por sí sola elasticidad ni capacidad para atender el pico. Se requieren mediciones y una estrategia de despliegue acorde.

## Atributos de calidad

Favorece la mantenibilidad, la simplicidad operativa y el tiempo de entrega. Limita la granularidad del escalado y comparte recursos entre las responsabilidades del monolito.

## Implementación y referencias

- [Módulo Inscripciones](../../api/src/modules/inscripciones/): rutas de inscripciones y turnos, asignación de cupos e integración con el padrón.
- [Entrada de la API](../../api/src/index.js) y [Docker Compose](../../docker-compose.yml): composición y despliegue local.
- [ADR-002](ADR-002-ingestion-asincronica.md): procesamiento asincrónico dentro de esta arquitectura.
