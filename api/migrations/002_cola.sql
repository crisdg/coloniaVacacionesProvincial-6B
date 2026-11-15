-- Resultado del padrón, separado del estado: una respuesta rápida no confirma
-- si hay solicitudes anteriores del mismo turno todavía sin resolver.
ALTER TABLE colonia.inscripciones
  ADD COLUMN es_residente boolean,
  ADD COLUMN padron_consultado_en timestamptz;

-- Bandeja de salida: el mensaje se guarda en la misma transacción que la solicitud.
-- Si RabbitMQ no está, la inscripción igual queda durable y se publica después.
CREATE TABLE colonia.salida (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inscripcion_id integer NOT NULL REFERENCES colonia.inscripciones (id),
  publicado_en timestamptz,
  creado_en timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX salida_sin_publicar ON colonia.salida (id) WHERE publicado_en IS NULL;

-- Contador global por segundo. Lo comparten todos los consumidores de la cola.
CREATE TABLE colonia.consultas_padron (
  segundo timestamptz PRIMARY KEY,
  cantidad integer NOT NULL CHECK (cantidad > 0)
);
