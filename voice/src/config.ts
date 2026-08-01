/**
 * Configuracion de loop-voice.
 *
 * Fuente: el `.env` de la RAIZ del repo (compartido por los tres servicios).
 * Este archivo NUNCA imprime el valor de una credencial. Solo si esta o no.
 */

import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// Carga del .env de la raiz
// -----------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url)); // <repo>/voice/src

/**
 * Candidatos, en orden. Se resuelve desde la ubicacion del modulo (robusto ante
 * el cwd desde el que se lance el proceso) y despues desde el cwd, por si se
 * ejecuta con un layout distinto.
 */
const ENV_CANDIDATES = [
  resolve(here, '../../.env'), // <repo>/.env   <- el bueno
  resolve(here, '../.env'), // <repo>/voice/.env (override local opcional)
  resolve(process.cwd(), '../.env'),
  resolve(process.cwd(), '.env'),
];

/** Ruta del .env que se cargo, o null. Util para el log de arranque. */
export const loadedEnvPath: string | null = (() => {
  for (const candidate of ENV_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    const result = loadDotenv({ path: candidate, override: false, quiet: true });
    if (!result.error) return candidate;
  }
  return null;
})();

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : fallback;
}

function optional(name: string): string | undefined {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : undefined;
}

function num(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// -----------------------------------------------------------------------------
// El objeto de configuracion
// -----------------------------------------------------------------------------

export const config = Object.freeze({
  /**
   * Puerto de loop-voice.
   *
   * IMPORTANTE: se lee de `VOICE_PORT`, NUNCA de `PORT`.
   * El `.env` compartido define `PORT=8787` para otro proceso del equipo; si
   * loop-voice usara `PORT` se levantaria en el puerto equivocado, el dashboard
   * de Carlos no encontraria el stream SSE en :3002 y romperiamos su servicio.
   */
  port: num('VOICE_PORT', 3002),

  /** Host de bind. 0.0.0.0 para que funcione detras de tuneles/containers. */
  host: str('VOICE_HOST', '0.0.0.0'),

  /**
   * Palanca de integracion. Default TRUE: con mocks, los clientes HTTP leen de
   * `shared/fixtures/` en vez de llamar a :3001 y :3003. Nadie se bloquea.
   * Solo se apaga poniendo literalmente `USE_MOCKS=false`.
   */
  useMocks: process.env.USE_MOCKS !== 'false',

  /** loop-core (Kiwis) — contexto del paciente y write-back del episodio. */
  coreUrl: str('LOOP_CORE_URL', 'http://localhost:3001'),

  /** loop-coverage (Carlos) — verificacion de cobertura via Stedi. */
  coverageUrl: str('LOOP_COVERAGE_URL', 'http://localhost:3003'),

  /** URL publica de este servicio (la usa el dashboard para el SSE). */
  voiceUrl: str('LOOP_VOICE_URL', 'http://localhost:3002'),

  /** Paciente fijo del demo. */
  patientId: str('LOOP_PATIENT_ID', 'loop-demo-patient-001'),

  /**
   * Deepgram — camino MANUAL (no Voice Agent API).
   * El STT corre en el SERVIDOR: el browser manda PCM crudo por WS a :3002 y
   * este proceso lo reenvia a Deepgram. Dos motivos, ambos de seguridad:
   *   1. El motor de red-flags DEBE ver el transcript en el servidor.
   *   2. La API key nunca sale al browser.
   */
  deepgram: Object.freeze({
    apiKey: optional('DEEPGRAM_API_KEY'),
    sttModel: str('DG_STT_MODEL', 'nova-3'),
    sttLanguage: str('DG_STT_LANGUAGE', 'multi'),
    ttsVoice: str('DG_TTS_VOICE', 'aura-2-selena-es'),
  }),

  /** AWS Polly — fallback de TTS si Deepgram falla o tarda mas de ttsMs. */
  polly: Object.freeze({
    voice: str('POLLY_VOICE', 'Lupe'),
    engine: str('POLLY_ENGINE', 'generative'),
  }),

  /**
   * AWS Bedrock — el LLM del agente (Converse streaming).
   * `modelId` es un inference-profile ID y se lee SIEMPRE del entorno.
   * Nunca se hardcodea un model id en el codigo.
   */
  aws: Object.freeze({
    region: str('AWS_REGION', 'us-east-1'),
    modelId: optional('AGENT_MODEL_ID'),
    accessKeyId: optional('AWS_ACCESS_KEY_ID'),
    secretAccessKey: optional('AWS_SECRET_ACCESS_KEY'),
    sessionToken: optional('AWS_SESSION_TOKEN'),
  }),

  /**
   * Timeouts de cada llamada saliente. Vencido el plazo se degrada, nunca se
   * lanza hacia arriba: la llamada del paciente no se cae por un downstream.
   */
  timeouts: Object.freeze({
    /** GET :3001/context — si no responde, se usa el ultimo contexto conocido. */
    contextMs: num('TIMEOUT_CONTEXT_MS', 2000),
    /** POST :3003/coverage/check — si no responde, voiceSummary honesto. */
    coverageMs: num('TIMEOUT_COVERAGE_MS', 3000),
    /** POST :3001/episodes — al colgar; si falla se loguea y ya. */
    episodeMs: num('TIMEOUT_EPISODE_MS', 5000),
    /** Deepgram TTS — pasado esto se cae a Polly. */
    ttsMs: num('TIMEOUT_TTS_MS', 4000),
  }),

  /** Idioma del demo. Decidido en T0: espanol. */
  language: 'es' as const,

  /** Nivel de log. */
  logLevel: str('LOG_LEVEL', 'info'),
});

export type AppConfig = typeof config;

// -----------------------------------------------------------------------------
// Chequeo de credenciales
// -----------------------------------------------------------------------------

interface CredentialCheck {
  name: string;
  present: boolean;
  degradation: string;
}

/**
 * Loguea un WARN por cada credencial que falta, indicando que funcionalidad
 * queda degradada. **No lanza nunca**: loop-voice tiene que arrancar aunque no
 * haya ni una sola credencial, porque el motor de red-flags no necesita ninguna
 * y ese es el entregable irrenunciable.
 *
 * Nunca imprime el valor de una credencial, solo si esta presente o no.
 */
export function assertConfig(): CredentialCheck[] {
  const checks: CredentialCheck[] = [
    {
      name: 'DEEPGRAM_API_KEY',
      present: Boolean(config.deepgram.apiKey),
      degradation: 'sin STT ni TTS de Deepgram: no hay voz (el TTS cae a Polly si hay AWS)',
    },
    {
      name: 'AGENT_MODEL_ID',
      present: Boolean(config.aws.modelId),
      degradation: 'sin LLM: el agente solo puede leer guiones fijos del care plan',
    },
    {
      name: 'AWS_ACCESS_KEY_ID',
      present: Boolean(config.aws.accessKeyId),
      degradation: 'sin Bedrock (LLM) ni Polly (TTS de respaldo)',
    },
    {
      name: 'AWS_SECRET_ACCESS_KEY',
      present: Boolean(config.aws.secretAccessKey),
      degradation: 'sin Bedrock (LLM) ni Polly (TTS de respaldo)',
    },
  ];

  const missing = checks.filter((c) => !c.present);

  console.info(
    `[config] loop-voice :${config.port} · useMocks=${config.useMocks} · lang=${config.language} · env=${loadedEnvPath ?? 'no encontrado'}`,
  );

  for (const check of missing) {
    console.warn(`[config] WARN: falta ${check.name} — ${check.degradation}`);
  }

  if (missing.length === 0) {
    console.info('[config] todas las credenciales presentes');
  } else {
    console.warn(
      '[config] el motor de red-flags NO depende de ninguna credencial: sigue siendo determinista y verificable.',
    );
  }

  return checks;
}
