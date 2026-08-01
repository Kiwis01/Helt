/**
 * Cliente de Medplum — SOLO SERVIDOR.
 *
 * `server-only` no es decorativo: si algún día alguien importa este módulo desde
 * un componente cliente, el build FALLA en vez de mandar `MEDPLUM_CLIENT_SECRET`
 * al navegador. Es la única barrera real que separa el secreto del bundle
 * público, así que no se quita ni "temporalmente".
 *
 * Por qué un singleton a nivel de módulo: `MedplumClient` cachea el access token
 * internamente, y el token dura una hora. Crear un cliente por petición
 * significaría un round-trip de OAuth por cada carga de página — con un jurado
 * mirando la pantalla, eso son cientos de milisegundos regalados.
 *
 * El proyecto NO se configura por variable de entorno a propósito: la respuesta
 * del `client_credentials` ya trae `project.reference`, así que `MEDPLUM_PROJECT_ID`
 * puede estar vacía (y de hecho lo está) sin que nada se rompa.
 */

import 'server-only';

// PRIMERO, y por su efecto: vuelca el `.env` de la raíz del monorepo en
// `process.env`. En ESM los imports se evalúan antes del cuerpo de este módulo,
// así que para cuando se leen las constantes de abajo las credenciales ya están.
// Si este import se mueve o se ordena alfabéticamente, `MEDPLUM_CLIENT_ID` sale
// `undefined` y el expediente cae a fixtures en silencio.
import './env';

import { MedplumClient } from '@medplum/core';

/* ================================================================== */
/* Configuración                                                       */
/* ================================================================== */

/** Quita la barra final: `MedplumClient` concatena rutas y `//fhir` no resuelve. */
function normalizeBaseUrl(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  return (value === '' ? 'https://api.medplum.com' : value).replace(/\/+$/, '');
}

const baseUrl = normalizeBaseUrl(process.env.MEDPLUM_BASE_URL);
const clientId = (process.env.MEDPLUM_CLIENT_ID ?? '').trim();
const clientSecret = (process.env.MEDPLUM_CLIENT_SECRET ?? '').trim();

/**
 * Sin credenciales el expediente no se cae: sirve fixtures y lo dice en pantalla.
 * Por eso esto es un booleano consultable y no un throw en tiempo de importación.
 */
export const medplumConfigured = clientId !== '' && clientSecret !== '';

/** Tiempo máximo que el expediente espera a Medplum antes de caer al respaldo. */
export const MEDPLUM_TIMEOUT_MS = 4000;

/**
 * Margen antes de la expiración para re-autenticar. El token vive 3600 s; con
 * 60 s de colchón nunca se usa uno que caduque a mitad de vuelo.
 */
const AUTH_GRACE_SECONDS = 60;

/* ================================================================== */
/* Singleton autenticado                                               */
/* ================================================================== */

let client: MedplumClient | null = null;
/** Login en vuelo. Evita que diez lecturas en paralelo disparen diez OAuth. */
let loginInFlight: Promise<void> | null = null;

function getClient(): MedplumClient {
  if (!client) {
    client = new MedplumClient({
      baseUrl,
      clientId,
      clientSecret,
      // El caché interno de MedplumClient guardaría respuestas entre peticiones.
      // El expediente se proyecta en vivo y se escribe a Medplum durante el demo:
      // enseñar una dosis cacheada justo después de cambiarla sería el peor bug
      // posible aquí. Lecturas siempre frescas.
      cacheTime: 0,
    });
  }
  return client;
}

/**
 * Devuelve un cliente ya autenticado, reutilizando el token mientras siga vivo.
 * Lanza si la autenticación falla — quien llama debe usar `medplumRead`, que ya
 * traduce ese fallo en una degradación visible.
 */
async function authenticated(): Promise<MedplumClient> {
  const medplum = getClient();

  if (medplum.isAuthenticated(AUTH_GRACE_SECONDS)) {
    return medplum;
  }

  if (!loginInFlight) {
    loginInFlight = medplum
      .startClientLogin(clientId, clientSecret)
      .then(() => undefined)
      .finally(() => {
        loginInFlight = null;
      });
  }

  await loginInFlight;
  return medplum;
}

/* ================================================================== */
/* Envoltura de resultado                                              */
/* ================================================================== */

/** De dónde salió el dato que se está pintando. Sube hasta un badge en pantalla. */
export type ChartSource = 'medplum' | 'fixture';

export type ChartFallbackReason =
  | 'not-configured'
  | 'auth-failed'
  | 'timeout'
  | 'network'
  | 'empty'
  | null;

export interface ChartResult<T> {
  data: T;
  source: ChartSource;
  reason: ChartFallbackReason;
  /** Detalle técnico corto, para el badge y la consola. Nunca se muestra solo. */
  detail: string | null;
}

/** Texto en inglés para el badge de origen. */
export function describeChartReason(reason: ChartFallbackReason): string {
  switch (reason) {
    case 'not-configured':
      return 'Medplum has no credentials';
    case 'auth-failed':
      return 'could not authenticate with Medplum';
    case 'timeout':
      return `Medplum did not respond in ${MEDPLUM_TIMEOUT_MS} ms`;
    case 'network':
      return 'Medplum is unavailable';
    case 'empty':
      return 'Medplum does not have this data';
    default:
      return 'Medplum data';
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/* ================================================================== */
/* Lectura degradable                                                  */
/* ================================================================== */

/**
 * Ejecuta una lectura contra Medplum con timeout y respaldo garantizado.
 *
 * Invariante: **nunca lanza**. El peor caso devuelve el fixture que ya se tenía
 * en la mano, marcado con el motivo. Quien consume esto no necesita try/catch
 * ni error boundary, igual que en `core-client.ts`.
 *
 * `fallbackData` se pasa por valor y no como getter perezoso justamente para que
 * no exista ninguna ruta capaz de fallar en el camino de respaldo.
 */
export async function medplumRead<T>(
  read: (medplum: MedplumClient) => Promise<T>,
  fallbackData: T,
  options?: { timeoutMs?: number },
): Promise<ChartResult<T>> {
  if (!medplumConfigured) {
    return { data: fallbackData, source: 'fixture', reason: 'not-configured', detail: null };
  }

  const timeoutMs = options?.timeoutMs ?? MEDPLUM_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const medplum = await authenticated().catch((error: unknown) => {
      // Se distingue del fallo de red porque el remedio es distinto: credencial
      // mala se arregla en .env, red caída se arregla sola.
      throw new AuthError(messageOf(error));
    });

    // `ReadablePromise` de Medplum no acepta AbortSignal en todas las rutas, así
    // que el timeout se impone desde fuera con una carrera. Si gana el reloj, la
    // petición sigue viva en segundo plano pero su resultado ya no se usa.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
    });

    const data = await Promise.race([read(medplum), timeout]);
    return { data, source: 'medplum', reason: null, detail: null };
  } catch (error) {
    if (error instanceof TimeoutError) {
      return { data: fallbackData, source: 'fixture', reason: 'timeout', detail: null };
    }
    if (error instanceof AuthError) {
      return { data: fallbackData, source: 'fixture', reason: 'auth-failed', detail: error.message };
    }
    return { data: fallbackData, source: 'fixture', reason: 'network', detail: messageOf(error) };
  } finally {
    clearTimeout(timer);
  }
}

class TimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'TimeoutError';
  }
}

class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Origen agregado de varias lecturas: basta con que una caiga al respaldo para
 * que la pantalla deje de poder presumir de datos en vivo.
 */
export function aggregateChartSource(
  results: readonly ChartResult<unknown>[],
): ChartResult<null> {
  const fallen = results.find((r) => r.source === 'fixture');
  if (!fallen) {
    return { data: null, source: 'medplum', reason: null, detail: null };
  }
  return { data: null, source: 'fixture', reason: fallen.reason, detail: fallen.detail };
}

/**
 * Acceso directo al cliente autenticado, para las rutas de ESCRITURA.
 *
 * A diferencia de `medplumRead`, esto SÍ lanza: una escritura que falla no puede
 * degradar en silencio a un fixture — el médico creería que recetó algo que no
 * se guardó. El route handler traduce el fallo en un error explícito en pantalla.
 */
export async function medplumWriteClient(): Promise<MedplumClient> {
  if (!medplumConfigured) {
    throw new Error('Medplum is not configured: MEDPLUM_CLIENT_ID or MEDPLUM_CLIENT_SECRET is missing.');
  }
  return authenticated();
}
