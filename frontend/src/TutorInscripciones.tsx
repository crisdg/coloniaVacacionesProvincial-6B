import { useEffect, useRef, useState, type FormEvent } from "react";

interface DatosChico {
  documento: string;
  nombre: string;
  apellido: string;
  fechaNacimiento: string;
}

interface Turno {
  id: number;
  sedeId: number;
  nombre: string;
  fechaInicio: string;
  fechaFin: string;
  inscripcionAbreEn: string;
  inscripcionCierraEn: string;
  cupoTotal: number;
  disponibles: number;
}

interface NuevoTurno {
  convocatoriaId: string;
  sedeId: number;
  nombre: string;
  fechaInicio: string;
  fechaFin: string;
  inscripcionAbreEn: string;
  inscripcionCierraEn: string;
  cupoTotal: string;
}

type EstadoInscripcion =
  | "pendiente_de_validacion"
  | "confirmada"
  | "en_lista_de_espera"
  | "rechazada"
  | "cancelada";

interface Inscripcion {
  id: number;
  turnoId: number;
  chico: DatosChico;
  estado: EstadoInscripcion;
  ordenRecepcion: number;
  creadoEn: string;
  motivoRechazo?: string;
  motivoCancelacion?: string;
}

interface SessionEvent extends CustomEvent<{ roles: string[] }> {}

const TOKEN_KEY = "colonia.access_token";
const TUTOR_KEY = "colonia.is_tutor";
const API_BASE = "/api";
const nuevoTurnoInicial: NuevoTurno = {
  convocatoriaId: "verano-2027",
  sedeId: 1,
  nombre: "",
  fechaInicio: "",
  fechaFin: "",
  inscripcionAbreEn: "",
  inscripcionCierraEn: "",
  cupoTotal: "",
};

const estilosEstado: Record<EstadoInscripcion, string> = {
  pendiente_de_validacion: "bg-yellow-100 text-yellow-800",
  confirmada: "bg-green-100 text-green-800",
  en_lista_de_espera: "bg-blue-100 text-blue-800",
  rechazada: "bg-red-100 text-red-800",
  cancelada: "bg-gray-100 text-gray-700",
};

const etiquetasEstado: Record<EstadoInscripcion, string> = {
  pendiente_de_validacion: "Pendiente de validación",
  confirmada: "Confirmada",
  en_lista_de_espera: "En lista de espera",
  rechazada: "Rechazada",
  cancelada: "Cancelada",
};

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  
  // Intentar rescatar cualquier token disponible por si acaso
  const token = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
  if (token) {
    const cleanToken = token.replace(/^"(.*)"$/, '$1');
    headers.set("Authorization", `Bearer ${cleanToken}`);
  }

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  // Realizamos la petición incluyendo credenciales para que el proxy/gateway reconozca la sesión activa
  const response = await fetch(`${API_BASE}${path}`, { 
    ...options, 
    headers,
    credentials: 'include' 
  });

  if (response.status === 401) {
    document.dispatchEvent(new CustomEvent("colonia:unauthorized"));
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const problem =
      typeof body === "object" && body !== null
        ? (body as { title?: unknown; detail?: unknown })
        : {};
    const detail = typeof problem.detail === "string" ? problem.detail : "";
    throw new Error(mensajeErrorApi(response.status, detail));
  }

  return response.json() as Promise<T>;
}

function mensajeErrorApi(status: number, detail: string): string {
  if (status === 401) return "La sesión no es válida o venció. Volvé a ingresar.";
  if (status === 403) return "No tenés permiso para realizar esta acción.";
  if (status === 400) return detail || "Revisá los datos ingresados.";
  if (status >= 500) return "Ocurrió un problema al comunicarse con el sistema. Intentá nuevamente.";
  return detail || "No se pudo completar la solicitud.";
}

function mostrarFecha(fecha: string): string {
  return new Date(`${fecha.slice(0, 10)}T12:00:00`).toLocaleDateString("es-AR");
}

function turnosVisibles(turnos: Turno[], esAdmin: boolean): Turno[] {
  if (esAdmin) return turnos;
  const ahora = Date.now();
  return turnos.filter(
    (turno) =>
      new Date(turno.inscripcionAbreEn).getTime() <= ahora &&
      ahora < new Date(turno.inscripcionCierraEn).getTime(),
  );
}

export default function TutorInscripciones() {
  const [esTutor, setEsTutor] = useState(() => sessionStorage.getItem(TUTOR_KEY) === "true");
  const [esAdmin, setEsAdmin] = useState(() => {
    // Si guardas el rol de admin o puedes verificarlo en el token/sessionstorage:
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) return false;
    try {
      // Decodificamos de forma segura el payload del JWT para ver los roles sin librerías externas
      const base64Url = token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      const payload = JSON.parse(jsonPayload);
      const roles = payload?.realm_access?.roles || [];
      return roles.includes("administrador");
    } catch {
      return false;
    }
  });
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [nuevoTurno, setNuevoTurno] = useState<NuevoTurno>(nuevoTurnoInicial);
  const [creandoTurno, setCreandoTurno] = useState(false);
  const [turnoCreado, setTurnoCreado] = useState("");
  const [inscripciones, setInscripciones] = useState<Inscripcion[]>([]);
  const [turnoSeleccionado, setTurnoSeleccionado] = useState<Turno | null>(null);
  const [inscripcion, setInscripcion] = useState<Inscripcion | null>(null);
  const [chico, setChico] = useState<DatosChico>({
    documento: "",
    nombre: "",
    apellido: "",
    fechaNacimiento: "",
  });
  const [cargandoTurnos, setCargandoTurnos] = useState(false);
  const [cargandoInscripciones, setCargandoInscripciones] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [actualizando, setActualizando] = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);
  const [edicion, setEdicion] = useState<DatosChico | null>(null);
  const [cancelandoId, setCancelandoId] = useState<number | null>(null);
  const [motivoCancelacion, setMotivoCancelacion] = useState("");
  const [procesandoId, setProcesandoId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const solicitudPendiente = useRef<{ payload: string; key: string } | null>(null);

  useEffect(() => {
    const actualizarSesion = (event: Event) => {
      const { roles } = (event as SessionEvent).detail;
      setEsTutor(roles.includes("tutor"));
      setEsAdmin(roles.includes("administrador"));
    };

    document.addEventListener("colonia:session", actualizarSesion);
    return () => document.removeEventListener("colonia:session", actualizarSesion);
  }, []);

  useEffect(() => {
    if (!esTutor && !esAdmin) {
      setInscripciones([]);
      return;
    }

    const controller = new AbortController();
    setCargandoInscripciones(true);
    setError("");

    apiFetch<Inscripcion[]>("/inscripciones", { signal: controller.signal })
      .then(setInscripciones)
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCargandoInscripciones(false);
      });

    return () => controller.abort();
  }, [esTutor, esAdmin]);

  useEffect(() => {
    if (!esTutor && !esAdmin) {
      setTurnos([]);
      setTurnoSeleccionado(null);
      setInscripcion(null);
      return;
    }

    const controller = new AbortController();
    setCargandoTurnos(true);
    setError("");

    apiFetch<Turno[]>("/turnos", { signal: controller.signal })
      .then((resultado) => setTurnos(turnosVisibles(resultado, esAdmin)))
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCargandoTurnos(false);
      });

    return () => controller.abort();
  }, [esTutor, esAdmin]);

  if (!esTutor && !esAdmin) return null;

  async function recargarInscripciones() {
    setCargandoInscripciones(true);
    try {
      setInscripciones(await apiFetch<Inscripcion[]>("/inscripciones"));
    } finally {
      setCargandoInscripciones(false);
    }
  }

  async function recargarTurnos() {
    setCargandoTurnos(true);
    try {
      const resultado = await apiFetch<Turno[]>("/turnos");
      setTurnos(turnosVisibles(resultado, esAdmin));
    } finally {
      setCargandoTurnos(false);
    }
  }

  async function crearTurno(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setTurnoCreado("");
    setCreandoTurno(true);

    try {
      const creado = await apiFetch<Turno>("/turnos", {
        method: "POST",
        body: JSON.stringify({
          convocatoriaId: nuevoTurno.convocatoriaId.trim(),
          sedeId: nuevoTurno.sedeId,
          nombre: nuevoTurno.nombre.trim(),
          fechaInicio: nuevoTurno.fechaInicio,
          fechaFin: nuevoTurno.fechaFin,
          inscripcionAbreEn: new Date(nuevoTurno.inscripcionAbreEn).toISOString(),
          inscripcionCierraEn: new Date(nuevoTurno.inscripcionCierraEn).toISOString(),
          cupoTotal: Number(nuevoTurno.cupoTotal),
        }),
      });

      setNuevoTurno(nuevoTurnoInicial);
      setTurnoCreado(`El turno “${creado.nombre}” se creó correctamente.`);
      try {
        await recargarTurnos();
      } catch {
        setError("El turno se creó, pero no se pudo actualizar el listado.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el turno.");
    } finally {
      setCreandoTurno(false);
    }
  }

  async function enviarInscripcion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!turnoSeleccionado) return;

    setError("");
    setEnviando(true);

    try {
      if (!crypto.randomUUID) {
        throw new Error("Este navegador no permite generar la clave de idempotencia.");
      }

      const body = JSON.stringify({
        turnoId: turnoSeleccionado.id,
        chico: {
          documento: chico.documento,
          nombre: chico.nombre,
          apellido: chico.apellido,
          fechaNacimiento: chico.fechaNacimiento,
        },
      });

      if (!solicitudPendiente.current || solicitudPendiente.current.payload !== body) {
        solicitudPendiente.current = { payload: body, key: crypto.randomUUID() };
      }

      const creada = await apiFetch<Inscripcion>("/inscripciones", {
        method: "POST",
        headers: { "Idempotency-Key": solicitudPendiente.current.key },
        body,
      });

      solicitudPendiente.current = null;
      setInscripcion(creada);
      setInscripciones((actuales) => [...actuales, creada]);
      const recargas = await Promise.allSettled([recargarInscripciones(), recargarTurnos()]);
      if (recargas.some((resultado) => resultado.status === "rejected")) {
        setError("La inscripción se envió, pero no se pudo actualizar toda la información.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo enviar la inscripción.");
    } finally {
      setEnviando(false);
    }
  }

  async function actualizarEstado() {
    if (!inscripcion) return;

    setError("");
    setActualizando(true);
    try {
      setInscripcion(await apiFetch<Inscripcion>(`/inscripciones/${inscripcion.id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo consultar el estado.");
    } finally {
      setActualizando(false);
    }
  }

  async function guardarCorreccion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editandoId === null || !edicion) return;
    setError("");
    setProcesandoId(editandoId);

    try {
      await apiFetch<Inscripcion>(`/inscripciones/${editandoId}`, {
        method: "PATCH",
        body: JSON.stringify({ chico: edicion }),
      });
      setEditandoId(null);
      setEdicion(null);
      await recargarInscripciones();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo corregir la inscripción.");
    } finally {
      setProcesandoId(null);
    }
  }

  async function cancelarInscripcion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (cancelandoId === null) return;
    setError("");
    setProcesandoId(cancelandoId);

    try {
      await apiFetch<Inscripcion>(`/inscripciones/${cancelandoId}/cancelaciones`, {
        method: "POST",
        body: JSON.stringify({ motivo: motivoCancelacion.trim() }),
      });
      setCancelandoId(null);
      setMotivoCancelacion("");
      const recargas = await Promise.allSettled([recargarInscripciones(), recargarTurnos()]);
      if (recargas.some((resultado) => resultado.status === "rejected")) {
        setError("La inscripción se canceló, pero no se pudo actualizar toda la información.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cancelar la inscripción.");
    } finally {
      setProcesandoId(null);
    }
  }

  function actualizarCampo(campo: keyof DatosChico, valor: string) {
    setChico((actual) => ({ ...actual, [campo]: valor }));
  }

  function campoChico(
    datos: DatosChico,
    actualizar: (campo: keyof DatosChico, valor: string) => void,
  ) {
    return (
      <>
        <label className="text-sm font-medium text-gray-700">
          DNI
          <input
            required
            minLength={7}
            maxLength={8}
            pattern="[0-9]{7,8}"
            inputMode="numeric"
            value={datos.documento}
            onChange={(event) => actualizar("documento", event.target.value)}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
          />
        </label>
        <label className="text-sm font-medium text-gray-700">
          Nombre
          <input
            required
            value={datos.nombre}
            onChange={(event) => actualizar("nombre", event.target.value)}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
          />
        </label>
        <label className="text-sm font-medium text-gray-700">
          Apellido
          <input
            required
            value={datos.apellido}
            onChange={(event) => actualizar("apellido", event.target.value)}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
          />
        </label>
        <label className="text-sm font-medium text-gray-700">
          Fecha de nacimiento
          <input
            required
            type="date"
            value={datos.fechaNacimiento.slice(0, 10)}
            onChange={(event) => actualizar("fechaNacimiento", event.target.value)}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
          />
        </label>
      </>
    );
  }

  return (
    <main className="mx-auto mt-10 w-full max-w-5xl rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
      <header className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
          {esAdmin ? "Panel de administración" : "Espacio del tutor"}
        </p>
        <h1 className="mt-2 text-3xl font-bold text-gray-900">
          {esAdmin ? "Gestión de la colonia" : "Inscripciones"}
        </h1>
        <p className="mt-2 text-gray-600">
          {esAdmin
            ? "Administrá los turnos y acompañá las solicitudes de inscripción."
            : "Elegí un turno con inscripción abierta."}
        </p>
      </header>

      {error && (
        <div role="alert" className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
          {error}
        </div>
      )}

      {esAdmin && (
        <section
          aria-labelledby="turnos-admin-titulo"
          className="mb-10 rounded-2xl border border-emerald-100 bg-emerald-50/40 p-5 sm:p-7"
        >
          <div className="mb-6">
            <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
              Administración
            </p>
            <h2 id="turnos-admin-titulo" className="mt-1 text-2xl font-bold text-gray-900">
              Turnos
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              Creá nuevos turnos y consultá los que ya están programados.
            </p>
          </div>

          {turnoCreado && (
            <p role="status" className="mb-5 rounded-lg border border-emerald-200 bg-white p-3 text-sm text-emerald-800">
              {turnoCreado}
            </p>
          )}

          <form onSubmit={crearTurno} className="rounded-xl border border-gray-200 bg-white p-5 sm:p-6">
            <h3 className="text-lg font-semibold text-gray-900">Crear turno</h3>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <label className="text-sm font-medium text-gray-700">
                Nombre del turno
                <input
                  required
                  value={nuevoTurno.nombre}
                  onChange={(event) => setNuevoTurno({ ...nuevoTurno, nombre: event.target.value })}
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                />
              </label>
              <label className="text-sm font-medium text-gray-700">
                ID de convocatoria
                <select
                  required
                  value={nuevoTurno.convocatoriaId}
                  onChange={(event) => setNuevoTurno({ ...nuevoTurno, convocatoriaId: event.target.value })}
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                >
                  <option value="verano-2027">Colonia de verano 2027 (verano-2027)</option>
                </select>
              </label>
              <label className="text-sm font-medium text-gray-700">
                ID de sede
                <select
                  required
                  value={nuevoTurno.sedeId}
                  onChange={(event) => setNuevoTurno({ ...nuevoTurno, sedeId: Number(event.target.value) })}
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                >
                  <option value={1}>1 - Polideportivo Central (Hurlingham)</option>
                  <option value={2}>2 - Parque Municipal (Morón)</option>
                  <option value={3}>3 - Club Social Norte (Ituzaingó)</option>
                </select>
              </label>
              <label className="text-sm font-medium text-gray-700">
                Fecha de inicio
                <input
                  required
                  type="date"
                  value={nuevoTurno.fechaInicio}
                  onChange={(event) => setNuevoTurno({ ...nuevoTurno, fechaInicio: event.target.value })}
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                />
              </label>
              <label className="text-sm font-medium text-gray-700">
                Fecha de fin
                <input
                  required
                  type="date"
                  min={nuevoTurno.fechaInicio || undefined}
                  value={nuevoTurno.fechaFin}
                  onChange={(event) => setNuevoTurno({ ...nuevoTurno, fechaFin: event.target.value })}
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                />
              </label>
              <label className="text-sm font-medium text-gray-700">
                Cupo total
                <input
                  required
                  type="number"
                  min="0"
                  step="1"
                  value={nuevoTurno.cupoTotal}
                  onChange={(event) => setNuevoTurno({ ...nuevoTurno, cupoTotal: event.target.value })}
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                />
              </label>
              <label className="text-sm font-medium text-gray-700">
                Apertura de inscripción
                <input
                  required
                  type="datetime-local"
                  value={nuevoTurno.inscripcionAbreEn}
                  onChange={(event) => setNuevoTurno({ ...nuevoTurno, inscripcionAbreEn: event.target.value })}
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                />
              </label>
              <label className="text-sm font-medium text-gray-700">
                Cierre de inscripción
                <input
                  required
                  type="datetime-local"
                  value={nuevoTurno.inscripcionCierraEn}
                  onChange={(event) => setNuevoTurno({ ...nuevoTurno, inscripcionCierraEn: event.target.value })}
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                />
              </label>
            </div>
            <button
              type="submit"
              disabled={creandoTurno}
              className="mt-5 rounded-lg bg-emerald-700 px-5 py-2.5 font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {creandoTurno ? "Creando turno..." : "Guardar turno"}
            </button>
          </form>

          <div className="mt-7">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-gray-900">Turnos programados</h3>
              <button
                type="button"
                onClick={() => recargarTurnos().catch((err: Error) => setError(err.message))}
                disabled={cargandoTurnos}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                {cargandoTurnos ? "Actualizando..." : "Actualizar turnos"}
              </button>
            </div>
            {cargandoTurnos ? (
              <p role="status" className="rounded-lg bg-white p-4 text-sm text-gray-600">Cargando turnos...</p>
            ) : turnos.length === 0 ? (
              <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">
                Todavía no hay turnos programados.
              </p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {turnos.map((turno) => (
                  <article key={turno.id} className="rounded-xl border border-gray-200 bg-white p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h4 className="font-semibold text-gray-900">{turno.nombre}</h4>
                        <p className="mt-1 text-sm text-gray-600">
                          Turno #{turno.id} · Sede {turno.sedeId}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
                        {turno.disponibles} / {turno.cupoTotal} cupos
                      </span>
                    </div>
                    <dl className="mt-4 space-y-2 text-sm text-gray-600">
                      <div className="flex justify-between gap-3">
                        <dt>Actividad</dt>
                        <dd className="text-right font-medium text-gray-900">
                          {mostrarFecha(turno.fechaInicio)} – {mostrarFecha(turno.fechaFin)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Inscripciones</dt>
                        <dd className="text-right font-medium text-gray-900">
                          {new Date(turno.inscripcionAbreEn).toLocaleString("es-AR")} –{" "}
                          {new Date(turno.inscripcionCierraEn).toLocaleString("es-AR")}
                        </dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      <section aria-labelledby="inscripciones-titulo" className="mb-10">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="inscripciones-titulo" className="text-xl font-semibold text-gray-900">
              {esAdmin ? "Todas las inscripciones" : "Mis inscripciones"}
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              {esAdmin
                ? "Podés corregir datos de solicitudes pendientes o cancelar inscripciones activas."
                : "Estado y datos de tus solicitudes."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setError("");
              recargarInscripciones().catch((err: Error) => setError(err.message));
            }}
            disabled={cargandoInscripciones}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            {cargandoInscripciones ? "Actualizando..." : "Actualizar lista"}
          </button>
        </div>

        {cargandoInscripciones ? (
          <p role="status" className="text-gray-600">Cargando inscripciones...</p>
        ) : inscripciones.length === 0 ? (
          <p className="rounded-lg border border-gray-200 bg-gray-50 p-5 text-gray-600">
            No hay inscripciones para mostrar.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200 text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-600">
                <tr>
                  <th scope="col" className="px-4 py-3">ID</th>
                  <th scope="col" className="px-4 py-3">Turno ID</th>
                  <th scope="col" className="px-4 py-3">Chico/a</th>
                  <th scope="col" className="px-4 py-3">DNI</th>
                  <th scope="col" className="px-4 py-3">Nacimiento</th>
                  <th scope="col" className="px-4 py-3">Estado</th>
                  {esAdmin && <th scope="col" className="px-4 py-3">Acciones</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {inscripciones.map((item) => (
                  <tr key={item.id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-4 font-medium text-gray-900">#{item.id}</td>
                    <td className="whitespace-nowrap px-4 py-4 text-gray-700">#{item.turnoId}</td>
                    <td className="px-4 py-4 text-gray-700">{item.chico.nombre} {item.chico.apellido}</td>
                    <td className="whitespace-nowrap px-4 py-4 text-gray-700">{item.chico.documento}</td>
                    <td className="whitespace-nowrap px-4 py-4 text-gray-700">
                      {mostrarFecha(item.chico.fechaNacimiento)}
                    </td>
                    <td className="px-4 py-4">
                      <span className={`inline-flex whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${estilosEstado[item.estado]}`}>
                        {etiquetasEstado[item.estado]}
                      </span>
                      {item.motivoRechazo && <p className="mt-2 max-w-xs text-xs text-red-700">{item.motivoRechazo}</p>}
                      {item.motivoCancelacion && <p className="mt-2 max-w-xs text-xs text-gray-600">{item.motivoCancelacion}</p>}
                    </td>
                    {esAdmin && (
                      <td className="min-w-64 px-4 py-4">
                        {item.estado === "pendiente_de_validacion" && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditandoId(item.id);
                              setEdicion({ ...item.chico });
                              setCancelandoId(null);
                            }}
                            className="mr-2 rounded-lg border border-gray-300 px-3 py-1.5 font-semibold text-gray-700 hover:bg-gray-50"
                          >
                            Corregir
                          </button>
                        )}
                        {item.estado !== "cancelada" && item.estado !== "rechazada" && (
                          <button
                            type="button"
                            onClick={() => {
                              setCancelandoId(item.id);
                              setMotivoCancelacion("");
                              setEditandoId(null);
                            }}
                            className="rounded-lg border border-red-200 px-3 py-1.5 font-semibold text-red-700 hover:bg-red-50"
                          >
                            Cancelar inscripción
                          </button>
                        )}
                        {editandoId === item.id && edicion && (
                          <form onSubmit={guardarCorreccion} className="mt-4 grid min-w-72 gap-3 rounded-lg bg-gray-50 p-3">
                            <h3 className="font-semibold text-gray-900">Corregir chico/a #{item.id}</h3>
                            {campoChico(edicion, (campo, valor) =>
                              setEdicion((actual) => actual ? { ...actual, [campo]: valor } : actual),
                            )}
                            <div className="flex gap-2">
                              <button type="submit" disabled={procesandoId === item.id} className="rounded-lg bg-emerald-700 px-3 py-2 font-semibold text-white hover:bg-emerald-800 disabled:opacity-60">
                                {procesandoId === item.id ? "Guardando..." : "Guardar"}
                              </button>
                              <button type="button" onClick={() => { setEditandoId(null); setEdicion(null); }} className="rounded-lg border border-gray-300 px-3 py-2 font-semibold text-gray-700">
                                Cerrar
                              </button>
                            </div>
                          </form>
                        )}
                        {cancelandoId === item.id && (
                          <form onSubmit={cancelarInscripcion} className="mt-4 min-w-72 rounded-lg bg-gray-50 p-3">
                            <label className="block text-sm font-medium text-gray-700">
                              Motivo obligatorio
                              <textarea
                                required
                                minLength={1}
                                value={motivoCancelacion}
                                onChange={(event) => setMotivoCancelacion(event.target.value)}
                                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2"
                                rows={3}
                              />
                            </label>
                            <div className="mt-3 flex gap-2">
                              <button type="submit" disabled={procesandoId === item.id || !motivoCancelacion.trim()} className="rounded-lg bg-red-700 px-3 py-2 font-semibold text-white hover:bg-red-800 disabled:opacity-60">
                                {procesandoId === item.id ? "Cancelando..." : "Confirmar baja"}
                              </button>
                              <button type="button" onClick={() => setCancelandoId(null)} className="rounded-lg border border-gray-300 px-3 py-2 font-semibold text-gray-700">
                                Cerrar
                              </button>
                            </div>
                          </form>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {esTutor && (
        <section aria-label="Solicitar una inscripción">
          <div className="mb-4">
            <h2 className="text-xl font-semibold text-gray-900">Turnos con inscripción abierta</h2>
            <p className="mt-1 text-sm text-gray-600">Elegí una actividad para iniciar una inscripción.</p>
          </div>
          {cargandoTurnos ? (
            <p role="status" className="text-gray-600">Cargando turnos...</p>
          ) : turnos.length === 0 ? (
            <p className="rounded-lg border border-gray-200 bg-gray-50 p-5 text-gray-600">
              No hay turnos con inscripción abierta en este momento.
            </p>
          ) : (
            <section aria-label="Turnos disponibles" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {turnos.map((turno) => (
                <button
                  key={turno.id}
                  type="button"
                  onClick={() => {
                    setTurnoSeleccionado(turno);
                    setInscripcion(null);
                    setError("");
                  }}
                  className={`rounded-xl border bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-500 hover:shadow-md ${
                    turnoSeleccionado?.id === turno.id
                      ? "border-emerald-600 ring-2 ring-emerald-100"
                      : "border-gray-200"
                  }`}
                >
                  <span className="text-sm font-medium text-emerald-700">Turno #{turno.id}</span>
                  <h2 className="mt-1 text-lg font-semibold text-gray-900">{turno.nombre}</h2>
                  <dl className="mt-4 space-y-2 text-sm text-gray-600">
                    <div className="flex justify-between gap-3">
                      <dt>Sede</dt>
                      <dd className="font-medium text-gray-900">{turno.sedeId}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt>Fechas</dt>
                      <dd className="text-right font-medium text-gray-900">
                        {mostrarFecha(turno.fechaInicio)} – {mostrarFecha(turno.fechaFin)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt>Cupos disponibles</dt>
                      <dd className="font-medium text-gray-900">
                        {turno.disponibles} / {turno.cupoTotal}
                      </dd>
                    </div>
                  </dl>
                </button>
              ))}
            </section>
          )}

      {turnoSeleccionado && !inscripcion && (
        <section className="mt-10 rounded-xl border border-gray-200 p-6">
          <h2 className="text-xl font-semibold text-gray-900">
            Inscribir a un chico en el turno #{turnoSeleccionado.id}
          </h2>

          <form onSubmit={enviarInscripcion} className="mt-5 grid gap-4 sm:grid-cols-2">
            {campoChico(chico, actualizarCampo)}

            <div className="flex flex-wrap gap-3 sm:col-span-2">
              <button
                type="submit"
                disabled={enviando}
                className="rounded-lg bg-emerald-700 px-5 py-2.5 font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {enviando ? "Enviando..." : "Enviar inscripción"}
              </button>
              <button
                type="button"
                onClick={() => setTurnoSeleccionado(null)}
                className="rounded-lg border border-gray-300 px-5 py-2.5 font-semibold text-gray-700 hover:bg-gray-50"
              >
                Cancelar
              </button>
            </div>
          </form>
        </section>
      )}

      {inscripcion && (
        <section aria-live="polite" className="mt-10 rounded-xl border border-gray-200 p-6">
          <h2 className="text-xl font-semibold text-gray-900">Solicitud recibida</h2>
          <p className="mt-2 text-gray-600">
            Identificador de inscripción:{" "}
            <span className="font-semibold text-gray-900">#{inscripcion.id}</span>
          </p>
          <span
            className={`mt-4 inline-flex rounded-full px-3 py-1 text-sm font-semibold ${estilosEstado[inscripcion.estado]}`}
          >
            {etiquetasEstado[inscripcion.estado]}
          </span>
          {inscripcion.motivoRechazo && (
            <p className="mt-3 text-sm text-red-700">{inscripcion.motivoRechazo}</p>
          )}

          {(inscripcion.estado === "pendiente_de_validacion" ||
            inscripcion.estado === "en_lista_de_espera") && (
            <button
              type="button"
              onClick={actualizarEstado}
              disabled={actualizando}
              className="mt-5 rounded-lg border border-gray-300 px-4 py-2 font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              {actualizando ? "Consultando..." : "Actualizar estado"}
            </button>
          )}
        </section>
      )}
        </section>
      )}
    </main>
  );
}