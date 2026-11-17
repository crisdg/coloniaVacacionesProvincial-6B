ALTER TABLE colonia.inscripciones
  ADD COLUMN padron_token uuid,
  ADD COLUMN padron_reclamado_hasta timestamptz,
  ADD CONSTRAINT reclamacion_padron_completa CHECK (
    (padron_token IS NULL) = (padron_reclamado_hasta IS NULL)
  );

-- Invalida incluso cambios A -> B -> A durante una consulta en vuelo.
CREATE FUNCTION colonia.invalidar_validacion_padron() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.documento, NEW.convocatoria_id, NEW.turno_id, NEW.nombre,
         NEW.apellido, NEW.fecha_nacimiento, NEW.tutor_id)
     IS DISTINCT FROM
     ROW(OLD.documento, OLD.convocatoria_id, OLD.turno_id, OLD.nombre,
         OLD.apellido, OLD.fecha_nacimiento, OLD.tutor_id)
     OR (NEW.estado IS DISTINCT FROM OLD.estado AND NEW.estado = 'cancelada') THEN
    NEW.padron_token := NULL;
    NEW.padron_reclamado_hasta := NULL;
  END IF;
  IF ROW(NEW.documento, NEW.convocatoria_id, NEW.turno_id)
     IS DISTINCT FROM ROW(OLD.documento, OLD.convocatoria_id, OLD.turno_id) THEN
    NEW.es_residente := NULL;
    NEW.padron_consultado_en := NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER invalidar_validacion_padron BEFORE UPDATE ON colonia.inscripciones
FOR EACH ROW EXECUTE FUNCTION colonia.invalidar_validacion_padron();
