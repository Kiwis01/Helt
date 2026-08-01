/**
 * Cliente de **loop-core** (:3001, Kiwis).
 *
 * Dos operaciones, con dos contratos de resiliencia distintos:
 *
 *   - `getPatientContext` — esta en el camino critico de la llamada.
 *     **Nunca lanza y nunca devuelve null.** Cadena de degradacion:
 *         live (:3001 valido)  ->  cache (ultimo contexto valido)
 *                              ->  fixture de shared/fixtures
 *                              ->  contexto minimo embebido en este archivo
 *     Siempre sale un `PatientContext` con `safetyEnvelope`, porque el motor de
 *     red-flags lo necesita y ese motor no puede quedarse sin envelope jamas.
 *
 *   - `postEpisode` — corre al colgar, fuera del camino critico. Si :3001 no
 *     esta, el episodio se guarda en `voice/.episodes-pending/` para no
 *     perderlo, y se devuelve null. Tampoco lanza.
 *
 * Este archivo NUNCA habla FHIR. Consume el JSON del Contrato 1 y manda el del
 * Contrato 2. Medplum es problema de Kiwis.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { config } from '../config.js';
import {
  episodeWritebackSchema,
  patientContextSchema,
  type EpisodeWriteback,
  type EpisodeWritebackResponse,
  type PatientContext,
} from '../types.js';
import { coerceContext } from './contextCoercion.js';
import { fetchJson, readFixture } from './http.js';

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

const FIXTURE_HAPPY = 'context.happy.json';
const FIXTURE_REDFLAG = 'context.redflag.json';

/** Perfiles que sirven el contexto con biometria fuera del envelope. */
const REDFLAG_PROFILES = new Set(['cardiac-redflag', 'redflag']);

const here = dirname(fileURLToPath(import.meta.url)); // <repo>/voice/src/clients

/** Buzon de episodios que no se pudieron entregar a :3001. */
export const PENDING_EPISODES_DIR = resolve(here, '../../.episodes-pending');

/** De donde salio el ultimo contexto servido. Se muestra en logs y en el demo. */
export type ContextSource = 'live' | 'cache' | 'fixture';

/**
 * Respuesta de POST /api/v1/episodes.
 *
 * Se declara aqui (y no se importa de shared) porque `voice/src/types.ts` no
 * re-exporta `episodeWritebackResponseSchema`, y la regla de la carpeta es que
 * ningun modulo de voice/ escriba la ruta relativa a `shared/`. Son dos campos
 * y `medplumUrl` se acepta ausente: si Kiwis nos da el encounterId, el episodio
 * ya se escribio y no vamos a tirar eso por una URL que falta.
 */
const episodeResponseSchema = z.object({
  encounterId: z.string().min(1),
  medplumUrl: z.string().default(''),
});

// -----------------------------------------------------------------------------
// Estado del modulo
// -----------------------------------------------------------------------------

interface CacheEntry {
  context: PatientContext;
  storedAt: number;
}

/** Ultimo contexto VALIDO por paciente. Solo se llena con datos live. */
const contextCache = new Map<string, CacheEntry>();

let lastSource: ContextSource = 'fixture';

/**
 * De donde salio el ultimo contexto servido: 'live' | 'cache' | 'fixture'.
 * El orquestador lo emite en los logs de arranque de llamada y el demo lo
 * puede pintar: es honestidad sobre la procedencia del dato.
 */
export function getContextSource(): ContextSource {
  return lastSource;
}

/** Solo para tests: vacia la cache y resetea la procedencia. */
export function resetCoreClientStateForTests(): void {
  contextCache.clear();
  lastSource = 'fixture';
}

// -----------------------------------------------------------------------------
// Contexto del paciente (Contrato 1)
// -----------------------------------------------------------------------------

export interface GetPatientContextOptions {
  /** 'cardiac-redflag' | 'redflag' sirven el fixture con biometria critica. */
  profile?: string;
}

/**
 * Contexto del paciente. **Nunca lanza, nunca devuelve null.**
 *
 * Con `USE_MOCKS=true` lee de `shared/fixtures/` sin tocar la red.
 * Con `USE_MOCKS=false` llama a :3001 y, ante cualquier problema (timeout, 5xx,
 * JSON roto, payload que no valida contra `patientContextSchema`), degrada en
 * silencio a la cache y despues al fixture. La conversacion sigue.
 */
export async function getPatientContext(
  patientId: string,
  opts: GetPatientContextOptions = {},
): Promise<PatientContext> {
  const fixtureName = REDFLAG_PROFILES.has(opts.profile ?? '') ? FIXTURE_REDFLAG : FIXTURE_HAPPY;

  if (config.useMocks) {
    lastSource = 'fixture';
    return loadFixtureContext(fixtureName, patientId);
  }

  const url = `${config.coreUrl}/api/v1/context/${encodeURIComponent(patientId)}?window=30m`;
  const timeoutMs = config.timeouts.contextMs;
  const result = await fetchJson<unknown>(url, {
    method: 'GET',
    timeoutMs,
    retries: 1,
    // Techo total de la operacion. Hay una llamada de voz esperando: preferimos
    // un contexto de hace 30 segundos a un silencio de cuatro segundos.
    budgetMs: Math.round(timeoutMs * 1.5),
    label: 'core/context',
  });

  if (result.ok) {
    const accepted = acceptContext(result.data, 'live');
    if (accepted !== null) {
      contextCache.set(patientId, { context: accepted, storedAt: Date.now() });
      lastSource = 'live';
      console.info(`[coreClient] contexto live de :3001 en ${result.latencyMs}ms (${patientId})`);
      return accepted;
    }
  } else {
    console.warn(
      `[coreClient] GET /context fallo tras ${result.latencyMs}ms (${result.error}) — degradando`,
    );
  }

  const cached = contextCache.get(patientId);
  if (cached) {
    lastSource = 'cache';
    const ageSeconds = Math.round((Date.now() - cached.storedAt) / 1000);
    console.warn(`[coreClient] usando ultimo contexto conocido (${ageSeconds}s de antiguedad)`);
    return cached.context;
  }

  lastSource = 'fixture';
  console.warn(`[coreClient] sin cache — usando fixture ${fixtureName}`);
  return loadFixtureContext(fixtureName, patientId);
}

/**
 * Precarga al arrancar el servidor / al iniciar la llamada.
 *
 * Es la unica optimizacion de latencia que hace este cliente: pagar el viaje a
 * :3001 antes de que el paciente hable, no durante su primer turno.
 */
export async function warmContext(
  patientId: string,
  opts: GetPatientContextOptions = {},
): Promise<PatientContext> {
  const context = await getPatientContext(patientId, opts);
  console.info(
    `[coreClient] contexto precargado para ${patientId} · fuente=${lastSource} · ` +
      `HR ${context.current.heartRate.latest}${context.current.heartRate.unit} ` +
      `(baseline ${context.baseline.heartRate.mean})`,
  );
  return context;
}

/**
 * Acepta un payload como `PatientContext`, en dos pasadas.
 *
 * =============================================================================
 *  POR QUE DOS PASADAS Y NO UN SOLO safeParse
 * =============================================================================
 * `patientContextSchema` exige literalmente todos los campos del ejemplo del
 * brief. Un contexto de Kiwis perfectamente utilizable al que le falte
 * `medications`, `baseline.sleepHours` o `deltas.hrv` —cosas que loop-voice no
 * necesita para conversar— fallaba la validacion, y el payload LIVE se tiraba
 * entero a favor del fixture. El sintoma en el escenario no es un error: es el
 * agente diciendo "tu ritmo esta en 118" (fixture) mientras el dashboard pinta
 * la lectura real de Kiwis. Dos numeros distintos para el mismo paciente y
 * nadie sabiendo cual creer.
 *
 *   1ª pasada: el schema tal cual. Si pasa, no se toco nada.
 *   2ª pasada: `coerceContext` rellena lo ausente (derivando lo derivable,
 *              con centinelas que el prompt omite) y se vuelve a validar.
 *
 * Si la segunda tambien falla —o `coerceContext` devuelve null porque no hay
 * frecuencia cardiaca— se devuelve `null` y el llamante degrada. No se rescata
 * un payload sin datos: eso seria disfrazar un fallo, no tolerarlo.
 */
function acceptContext(raw: unknown, origin: string): PatientContext | null {
  const strict = patientContextSchema.safeParse(raw);
  if (strict.success) return strict.data as PatientContext;

  const coerced = coerceContext(raw);
  if (coerced === null) {
    console.warn(
      `[coreClient] contexto ${origin} inservible (sin frecuencia cardiaca actual o de ` +
        `referencia) — ${formatIssues(strict.error)}`,
    );
    return null;
  }

  const lenient = patientContextSchema.safeParse(coerced.value);
  if (!lenient.success) {
    console.warn(
      `[coreClient] contexto ${origin} no valida ni tras normalizar — ${formatIssues(lenient.error)}`,
    );
    return null;
  }

  console.warn(
    `[coreClient] contexto ${origin} aceptado con campos rellenados: ` +
      `${coerced.filled.join(', ') || '(ninguno)'}. Se conservan los datos reales de loop-core; ` +
      'lo ausente no se locuta.',
  );
  return lenient.data as PatientContext;
}

/**
 * Fixture -> contexto valido. Si el fixture no existe o no valida, cae al
 * contexto minimo embebido: es el suelo de la cadena de degradacion.
 */
function loadFixtureContext(fileName: string, patientId: string): PatientContext {
  const raw = readFixture(fileName);
  if (raw !== null) {
    const accepted = acceptContext(raw, `fixture ${fileName}`);
    if (accepted !== null) return withPatientId(accepted, patientId);
  }
  console.warn('[coreClient] usando el contexto minimo embebido (ultimo recurso)');
  // Copia: el embebido es una constante del modulo y nadie debe mutarla.
  return withPatientId(structuredClone(FALLBACK_CONTEXT), patientId);
}

/**
 * El fixture trae el paciente del demo. Si alguien pide otro id, se respeta el
 * pedido para que el episodio no se escriba contra el paciente equivocado.
 */
function withPatientId(context: PatientContext, patientId: string): PatientContext {
  if (!patientId || context.patientId === patientId) return context;
  return { ...context, patientId };
}

// -----------------------------------------------------------------------------
// Write-back del episodio (Contrato 2)
// -----------------------------------------------------------------------------

/**
 * Escribe el episodio en loop-core. Devuelve null si no se pudo.
 *
 * El payload se valida ANTES de mandarlo, pero un fallo de validacion **no
 * bloquea el cierre de la llamada**: se loguea el detalle de zod y se manda
 * igual. Perder el episodio es peor que mandar uno imperfecto — que Kiwis lo
 * rechace con un 400 es informacion util; que nunca salga, no.
 */
export async function postEpisode(
  payload: EpisodeWriteback,
): Promise<EpisodeWritebackResponse | null> {
  const callId = safeCallId(payload);

  const validation = episodeWritebackSchema.safeParse(payload);
  if (!validation.success) {
    console.error(
      `[coreClient] el episodio ${callId} NO valida contra episodeWritebackSchema ` +
        '(se continua igualmente para no perderlo):',
    );
    for (const issue of validation.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(raiz)';
      console.error(`  · ${path}: ${issue.message}`);
    }
  }

  if (config.useMocks) {
    console.info(`[coreClient] USE_MOCKS — episodio ${callId} NO enviado a :3001. Payload:`);
    console.info(safeStringify(payload));
    const encounterId = `enc-mock-${callId}`;
    return { encounterId, medplumUrl: `https://app.medplum.com/Encounter/${encounterId}` };
  }

  const result = await fetchJson<unknown>(`${config.coreUrl}/api/v1/episodes`, {
    method: 'POST',
    body: payload,
    timeoutMs: config.timeouts.episodeMs,
    // Cero reintentos: POST /episodes no es idempotente y duplicar un Encounter
    // en Medplum es peor que reintentarlo a mano desde .episodes-pending/.
    retries: 0,
    label: 'core/episodes',
  });

  if (result.ok) {
    const parsed = episodeResponseSchema.safeParse(result.data);
    if (parsed.success) {
      console.info(
        `[coreClient] episodio ${callId} escrito en ${result.latencyMs}ms → ${parsed.data.encounterId}`,
      );
      return { encounterId: parsed.data.encounterId, medplumUrl: parsed.data.medplumUrl };
    }
    // :3001 acepto el episodio: ya esta escrito. Guardarlo como pendiente solo
    // conseguiria que alguien lo reenvie y duplique el Encounter.
    console.warn(
      `[coreClient] :3001 acepto el episodio ${callId} pero la respuesta no valida ` +
        `(${formatIssues(parsed.error)}) — no se guarda pendiente`,
    );
    return null;
  }

  console.error(`[coreClient] POST /episodes fallo (${result.error}) — guardando pendiente`);
  await writePendingEpisode(callId, payload);
  return null;
}

/**
 * Deja el episodio en disco para poder reenviarlo despues del demo.
 * Nunca lanza: si ni siquiera se puede escribir, se loguea y se sigue.
 */
async function writePendingEpisode(callId: string, payload: EpisodeWriteback): Promise<void> {
  try {
    await mkdir(PENDING_EPISODES_DIR, { recursive: true });
    // El buzon es un artefacto de runtime, no codigo: se auto-ignora en git sin
    // tocar el .gitignore de la raiz (que no es de loop-voice).
    await writeFile(resolve(PENDING_EPISODES_DIR, '.gitignore'), '*\n', 'utf8');
    const path = resolve(PENDING_EPISODES_DIR, `${callId}.json`);
    await writeFile(path, safeStringify(payload), 'utf8');
    console.error(`[coreClient] episodio pendiente guardado en ${path}`);
  } catch (err) {
    console.error(
      `[coreClient] tampoco se pudo guardar el episodio pendiente: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * `callId` saneado para usarlo como nombre de archivo. Viene de nuestro propio
 * `CallSession`, pero un id con `/` o `..` escribiria fuera del buzon.
 */
function safeCallId(payload: EpisodeWriteback | null | undefined): string {
  const raw = typeof payload?.callId === 'string' ? payload.callId.trim() : '';
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  return clean.length > 0 ? clean : 'sin-callid';
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(raiz)'}: ${issue.message}`)
    .join(' | ');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// -----------------------------------------------------------------------------
// Ultimo recurso: contexto minimo embebido
// -----------------------------------------------------------------------------

/**
 * Contexto de emergencia si `shared/fixtures/` no esta disponible (repo a
 * medias, build empaquetado, permisos).
 *
 * No es decoracion: garantiza que `getPatientContext` cumpla su promesa de no
 * devolver null NUNCA, y por tanto que el motor de red-flags siempre tenga un
 * `safetyEnvelope` contra el que evaluar RF-08. Los valores son los del
 * paciente del demo para que el agente pueda seguir citando numeros concretos.
 */
const FALLBACK_CONTEXT: PatientContext = {
  patientId: 'loop-demo-patient-001',
  displayName: 'Alex Rivera',
  age: 34,
  generatedAt: '2026-08-01T18:22:11Z',
  baseline: {
    heartRate: { mean: 68, sd: 6, unit: 'bpm' },
    hrv: { mean: 54, sd: 11, unit: 'ms' },
    respiratoryRate: { mean: 14, sd: 2, unit: 'breaths/min' },
    sleepHours: { mean: 6.8, sd: 1.1, unit: 'h' },
  },
  current: {
    windowMinutes: 30,
    heartRate: { latest: 118, max: 126, trend: 'rising', unit: 'bpm' },
    hrv: { latest: 21, min: 18, trend: 'falling', unit: 'ms' },
    respiratoryRate: { latest: 24, max: 27, trend: 'rising', unit: 'breaths/min' },
    lastSampleAt: '2026-08-01T18:21:40Z',
  },
  deltas: {
    heartRate: { absolute: 50, sdFromBaseline: 8.3 },
    hrv: { absolute: -33, sdFromBaseline: -3 },
  },
  conditions: [],
  carePlan: {
    id: 'loop-demo-careplan-001',
    authoredBy: 'Dr. Maya Chen',
    lastUpdated: '2026-07-02',
    activities: [
      {
        id: 'cp-act-1',
        order: 1,
        type: 'breathing',
        title: 'Box breathing',
        instruction: '4 in, 4 hold, 4 out, 4 hold — 5 cycles',
        durationMinutes: 4,
        voiceScript:
          'Vamos a hacerlo juntos, sin prisa.\nInhala por la nariz mientras cuento cuatro: uno, dos, tres, cuatro.\nSosten el aire: uno, dos, tres, cuatro.\nExhala despacio por la boca: uno, dos, tres, cuatro.\nQuedate vacio un momento: uno, dos, tres, cuatro.',
      },
    ],
  },
  recentEpisodes: [],
  medications: [],
  safetyEnvelope: {
    heartRateMax: 150,
    heartRateMin: 40,
    respiratoryRateMax: 32,
    spo2Min: 92,
    note: 'Envelope embebido de respaldo. RF-08 sigue siendo evaluable sin red ni fixtures.',
  },
};
