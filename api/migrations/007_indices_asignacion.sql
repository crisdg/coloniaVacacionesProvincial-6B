-- Primera validación que impide avanzar al resto del turno.
CREATE INDEX inscripciones_barrera_validacion
  ON colonia.inscripciones (turno_id, orden_recepcion)
  WHERE estado = 'pendiente_de_validacion' AND es_residente IS NULL;

-- Solo candidatos a una plaza; permite ORDER BY ... LIMIT sin ordenar la lista.
CREATE INDEX inscripciones_candidatas_cupo
  ON colonia.inscripciones (turno_id, orden_recepcion)
  WHERE estado = 'en_lista_de_espera'
     OR (estado = 'pendiente_de_validacion' AND es_residente = true);

-- Clasificar resultados nuevos sin recorrer los que ya esperan una plaza.
CREATE INDEX inscripciones_pendientes_resueltas
  ON colonia.inscripciones (turno_id, orden_recepcion)
  WHERE estado = 'pendiente_de_validacion' AND es_residente IS NOT NULL;
