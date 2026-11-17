import { useEffect, useRef, useState, type FormEvent } from "react";

interface DatosChico {
  chicoDni: string;
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

type EstadoInscripcion =
  | "pendiente_de_validacion"
  | "confirmada"
  | "en_lista_de_espera"
  | "rechazada"
  | "cancelada";

interface Inscripcion {
  id: number;
  turnoId: number;
  estado: EstadoInscripcion;
  motivoRechazo?: string;
}

interface SessionEvent extends CustomEvent<{ roles: string[] }> {}

const TOKEN_KEY = "colonia.access_token";
const TUTOR_KEY = "colonia.is_tutor";
// Apuntamos directamente al Gateway (puerto 8000) según la arquitectura del TP[cite: 5]
const GATEWAY_URL = "http://localhost:8000";

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
  const token = sessionStorage.getItem(TOKEN_KEY);

  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body) headers.set("Content-Type", "application/json");

  // El Gateway atiende directo en /turnos y /inscripciones (sin el prefijo /api)
  const response = await fetch(`${GATEWAY_URL}${path}`, { ...options, headers });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail =
      typeof body === "object" && body !== null && "detail" in body
        ? String(body.detail)
        : typeof body === "object" && body !== null && "title" in body
          ? String(body.title)
          : `Error ${response.status}: ${response.statusText}`;
    throw new Error(detail);
  }

  return response.json() as Promise<T>;
}

function mostrarFecha(fecha: string): string {
  return new Date(`${fecha.slice(0, 10)}T12:00:00`).toLocaleDateString("es-AR");
}

export default function TutorInscripciones() {
  const [esTutor, setEsTutor] = useState(() => sessionStorage.getItem(TUTOR_KEY) === "true");
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [turnoSeleccionado, setTurnoSeleccionado] = useState<Turno | null>(null);
  const [inscripcion, setInscripcion] = useState<Inscripcion | null>(null);
  const [chico, setChico] = useState<DatosChico>({
    chicoDni: "",
    nombre: "",
    apellido: "",
    fechaNacimiento: "",
  });
  const [cargandoTurnos, setCargandoTurnos] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [actualizando, setActualizando] = useState(false);
  const [error, setError] = useState("");
  const solicitudPendiente = useRef<{ payload: string; key: string } | null>(null);

  useEffect(() => {
    const actualizarSesion = (event: Event) => {
      const { roles } = (event as SessionEvent).detail;
      setEsTutor(roles.includes("tutor"));
    };

    document.addEventListener("colonia:session", actualizarSesion);
    return () => document.removeEventListener("colonia:session", actualizarSesion);
  }, []);

  useEffect(() => {
    if (!esTutor) {
      setTurnos([]);
      setTurnoSeleccionado(null);
      setInscripcion(null);
      return;
    }

    const controller = new AbortController();
    setCargandoTurnos(true);
    setError("");

    apiFetch<Turno[]>("/turnos", { signal: controller.signal })
      .then((resultado) => {
        const ahora = Date.now();
        setTurnos(
          resultado.filter(
            (turno) =>
              new Date(turno.inscripcionAbreEn).getTime() <= ahora &&
              ahora < new Date(turno.inscripcionCierraEn).getTime(),
          ),
        );
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCargandoTurnos(false);
      });

    return () => controller.abort();
  }, [esTutor]);

  if (!esTutor) return null;

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
          documento: chico.chicoDni,
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

  function actualizarCampo(campo: keyof DatosChico, valor: string) {
    setChico((actual) => ({ ...actual, [campo]: valor }));
  }

  return (
    <main className="mx-auto mt-10 w-full max-w-5xl rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
      <header className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
          Espacio del tutor
        </p>
        <h1 className="mt-2 text-3xl font-bold text-gray-900">Inscripción de chicos</h1>
        <p className="mt-2 text-gray-600">Elegí un turno con inscripción abierta.</p>
      </header>

      {error && (
        <div role="alert" className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
          {error}
        </div>
      )}

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
            <label className="text-sm font-medium text-gray-700">
              DNI
              <input
                required
                minLength={7}
                maxLength={8}
                pattern="[0-9]{7,8}"
                inputMode="numeric"
                value={chico.chicoDni}
                onChange={(event) => actualizarCampo("chicoDni", event.target.value)}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
              />
            </label>

            <label className="text-sm font-medium text-gray-700">
              Nombre
              <input
                required
                value={chico.nombre}
                onChange={(event) => actualizarCampo("nombre", event.target.value)}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
              />
            </label>

            <label className="text-sm font-medium text-gray-700">
              Apellido
              <input
                required
                value={chico.apellido}
                onChange={(event) => actualizarCampo("apellido", event.target.value)}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
              />
            </label>

            <label className="text-sm font-medium text-gray-700">
              Fecha de nacimiento
              <input
                required
                type="date"
                value={chico.fechaNacimiento}
                onChange={(event) => actualizarCampo("fechaNacimiento", event.target.value)}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-100"
              />
            </label>

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
    </main>
  );
}