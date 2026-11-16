-- Reserva y respuesta se escriben junto con inscripción/outbox en una transacción.
-- Una reserva sin respuesta nunca debe confirmarse: cualquier error hace rollback.
CREATE TABLE colonia.solicitudes_idempotentes (
  tutor_id text NOT NULL,
  clave varchar(128) NOT NULL,
  solicitud jsonb NOT NULL,
  respuesta jsonb,
  creado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tutor_id, clave)
);
