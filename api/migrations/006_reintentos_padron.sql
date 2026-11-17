ALTER TABLE colonia.inscripciones
  ADD COLUMN padron_intentos integer NOT NULL DEFAULT 0 CHECK (padron_intentos >= 0),
  ADD COLUMN padron_ultimo_intento_en timestamptz,
  ADD COLUMN padron_proximo_intento_en timestamptz,
  ADD COLUMN padron_ultimo_error text;

-- Una corrección no hereda la espera de una consulta invalidada.
CREATE FUNCTION colonia.reiniciar_espera_padron() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.documento, NEW.convocatoria_id, NEW.turno_id, NEW.nombre,
         NEW.apellido, NEW.fecha_nacimiento, NEW.tutor_id)
     IS DISTINCT FROM
     ROW(OLD.documento, OLD.convocatoria_id, OLD.turno_id, OLD.nombre,
         OLD.apellido, OLD.fecha_nacimiento, OLD.tutor_id)
     OR (NEW.estado IS DISTINCT FROM OLD.estado AND NEW.estado = 'cancelada') THEN
    NEW.padron_proximo_intento_en := NULL;
    NEW.padron_ultimo_error := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reiniciar_espera_padron BEFORE UPDATE ON colonia.inscripciones
FOR EACH ROW EXECUTE FUNCTION colonia.reiniciar_espera_padron();
