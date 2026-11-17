-- Registro de permisos, compartido por todas las réplicas y conservado en reinicios.
-- El contador anterior era técnico, no contenía inscripciones ni datos del padrón.
DROP TABLE colonia.consultas_padron;

CREATE TABLE colonia.permisos_padron (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  concedido_en timestamptz NOT NULL
);
CREATE INDEX permisos_padron_por_instante ON colonia.permisos_padron (concedido_en);
