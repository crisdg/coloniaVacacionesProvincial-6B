-- Modelo del módulo Inscripciones: catálogo precargado, turnos e inscripciones.

CREATE TABLE colonia.convocatorias (
  id text PRIMARY KEY,
  nombre text NOT NULL,
  jurisdiccion text NOT NULL
);

CREATE TABLE colonia.sedes (
  id integer PRIMARY KEY,
  nombre text NOT NULL,
  localidad text NOT NULL
);

CREATE TABLE colonia.turnos (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  convocatoria_id text NOT NULL REFERENCES colonia.convocatorias (id),
  sede_id integer NOT NULL REFERENCES colonia.sedes (id),
  nombre text NOT NULL CHECK (btrim(nombre) <> ''),
  fecha_inicio date NOT NULL,
  fecha_fin date NOT NULL,
  inscripcion_abre_en timestamptz NOT NULL,
  inscripcion_cierra_en timestamptz NOT NULL,
  cupo_total integer NOT NULL CHECK (cupo_total >= 0),
  CHECK (fecha_inicio <= fecha_fin),
  CHECK (inscripcion_abre_en < inscripcion_cierra_en)
);

-- El orden de recepción sale de una secuencia: es único, crece y no se reutiliza.
CREATE SEQUENCE colonia.orden_recepcion;

CREATE TABLE colonia.inscripciones (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  turno_id integer NOT NULL REFERENCES colonia.turnos (id),
  convocatoria_id text NOT NULL REFERENCES colonia.convocatorias (id),
  tutor_id text NOT NULL,
  documento text NOT NULL CHECK (documento ~ '^[0-9]{7,8}$'),
  nombre text NOT NULL CHECK (btrim(nombre) <> ''),
  apellido text NOT NULL CHECK (btrim(apellido) <> ''),
  fecha_nacimiento date NOT NULL,
  estado text NOT NULL DEFAULT 'pendiente_de_validacion'
    CHECK (estado IN ('pendiente_de_validacion', 'confirmada', 'en_lista_de_espera', 'rechazada', 'cancelada')),
  orden_recepcion bigint NOT NULL UNIQUE DEFAULT nextval('colonia.orden_recepcion'),
  creado_en timestamptz NOT NULL DEFAULT now(),
  motivo_rechazo text,
  motivo_cancelacion text
);

-- Una sola inscripción activa por DNI y convocatoria, aun con pedidos concurrentes.
CREATE UNIQUE INDEX inscripcion_activa_por_dni
  ON colonia.inscripciones (convocatoria_id, documento)
  WHERE estado IN ('pendiente_de_validacion', 'confirmada', 'en_lista_de_espera');

CREATE INDEX inscripciones_por_tutor ON colonia.inscripciones (tutor_id);
CREATE INDEX inscripciones_por_turno ON colonia.inscripciones (turno_id, estado);

INSERT INTO colonia.convocatorias (id, nombre, jurisdiccion) VALUES
  ('verano-2027', 'Colonia de verano 2027', 'Provincia');

INSERT INTO colonia.sedes (id, nombre, localidad) VALUES
  (1, 'Polideportivo Central', 'Hurlingham'),
  (2, 'Parque Municipal', 'Morón'),
  (3, 'Club Social Norte', 'Ituzaingó');
