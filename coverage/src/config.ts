/**
 * Configuración de loop-coverage.
 *
 * Los nombres de las variables salen de `ops/.env.example` y son idénticos en
 * los cuatro servicios. El servicio ARRANCA SIEMPRE, aunque no haya nada
 * configurado: si falta lo que hace falta para hablar con Stedi cae a modo mock
 * y lo dice en `/healthz`. Nadie debe quedarse bloqueado esperando el alta.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { PORTS, TIMEOUTS_MS } from '@loop/shared';

import { applyEnvFile, type EnvFileReport } from './env-file.js';
import type { MockScenario } from './mock.js';

/* ------------------------------------------------------------------ */
/* Esquema de entorno                                                  */
/* ------------------------------------------------------------------ */

/**
 * En un `.env` copiado de la plantilla, las claves sin valor llegan como string
 * vacío. Para nosotros eso es "no configurado", no "configurado con nada".
 */
const blankAsMissing = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalString = z.preprocess(blankAsMissing, z.string().trim().optional());

const EnvSchema = z.object({
  USE_MOCKS: optionalString,
  PORT: z.preprocess(blankAsMissing, z.coerce.number().int().min(0).max(65_535).optional()),
  HOST: optionalString,
  LOG_LEVEL: z.preprocess(
    blankAsMissing,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  ),

  /** Idioma del `voiceSummary`. El equipo aún no decidió el del demo. */
  COVERAGE_VOICE_LANG: z.preprocess(blankAsMissing, z.enum(['es', 'en']).optional()),
  /** Fuerza un escenario en modo mock. Útil en el ensayo del demo. */
  COVERAGE_MOCK_SCENARIO: z.preprocess(
    blankAsMissing,
    z.enum(['covered', 'needsauth', 'unknown']).optional(),
  ),

  STEDI_API_KEY: optionalString,
  STEDI_ENV: optionalString,
  STEDI_BASE_URL: optionalString,
  STEDI_ELIGIBILITY_PATH: optionalString,
  STEDI_AUTH_SCHEME: optionalString,

  STEDI_TEST_PAYER_ID: optionalString,
  STEDI_TEST_PAYER_NAME: optionalString,
  STEDI_TEST_MEMBER_ID: optionalString,
  STEDI_TEST_MEMBER_FIRST_NAME: optionalString,
  STEDI_TEST_MEMBER_LAST_NAME: optionalString,
  STEDI_TEST_MEMBER_DOB: optionalString,

  STEDI_PROVIDER_NPI: optionalString,
  STEDI_PROVIDER_ORG_NAME: optionalString,

  /** Ruta del `.env` a cargar, o `none` para no cargar ninguno. Ver `env-file.ts`. */
  COVERAGE_ENV_FILE: optionalString,
});

/* ------------------------------------------------------------------ */
/* Defaults de Stedi                                                   */
/* ------------------------------------------------------------------ */

/**
 * ASUNCIÓN: host y ruta de la Real-Time Eligibility Check API de Stedi
 * Healthcare. No hay credenciales en este entorno para verificarlo, así que
 * ambos son configurables por entorno — corregirlos es cambiar una variable,
 * no tocar código.
 */
const DEFAULT_STEDI_BASE_URL = 'https://healthcare.us.stedi.com';
const DEFAULT_STEDI_ELIGIBILITY_PATH = '/2024-04-01/change/medicalnetwork/eligibility/v3';

/**
 * El sandbox espera `YYYYMMDD`; el `.env` lo trae como `YYYY-MM-DD`.
 *
 * Se normaliza aquí, al arrancar, y no al construir el 270: así una fecha
 * inservible se detecta antes de salir a modo real, en vez de viajar como
 * `null` dentro de la petición.
 */
export function normalizeDob(dob: string | null): string | null {
  if (dob === null) return null;
  const digits = dob.replace(/\D/g, '');
  return digits.length === 8 ? digits : null;
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

export interface StediConfig {
  apiKey: string | null;
  environment: string;
  baseUrl: string;
  eligibilityPath: string;
  /**
   * ASUNCIÓN: Stedi espera la API key cruda en `Authorization`, sin esquema.
   * Si resulta que quiere `Bearer`, se pone `STEDI_AUTH_SCHEME=Bearer`.
   */
  authScheme: string | null;
  payerId: string | null;
  payerName: string;
  memberId: string | null;
  memberFirstName: string | null;
  memberLastName: string | null;
  /** Ya normalizado a `YYYYMMDD`. `null` si el valor del `.env` no servía. */
  memberDob: string | null;
  providerNpi: string | null;
  providerOrgName: string;
  /** De `TIMEOUTS_MS.stediUpstream`. Estrictamente menor que `coverageCheck`. */
  timeoutMs: number;
}

export interface AppConfig {
  /** true si `USE_MOCKS=true` O si falta algo para poder llamar a Stedi. */
  useMocks: boolean;
  /** true solo si están TODAS las variables que exige el 270. */
  stediConfigured: boolean;
  /** Qué le falta a Stedi para poder salir a real. Vacío si no falta nada. */
  stediMissing: string[];
  lang: 'es' | 'en';
  mockScenarioOverride: MockScenario | null;
  port: number;
  host: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  version: string;
  stedi: StediConfig;
}

function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const version =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['version']
        : undefined;
    return typeof version === 'string' ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Un env malformado es un error de despliegue, no de runtime: se falla
    // ruidosamente al arrancar, que es cuando alguien todavía puede arreglarlo.
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Variables de entorno inválidas para loop-coverage — ${detail}`);
  }

  const e = parsed.data;
  const apiKey = e.STEDI_API_KEY ?? null;
  const payerId = e.STEDI_TEST_PAYER_ID ?? null;
  const memberId = e.STEDI_TEST_MEMBER_ID ?? null;
  const memberDobRaw = e.STEDI_TEST_MEMBER_DOB ?? null;
  const memberDob = normalizeDob(memberDobRaw);

  /*
   * El mínimo viable del 270. La API key sola NO basta: con `ops/.env.example`
   * copiado tal cual, `STEDI_TEST_PAYER_ID`, `STEDI_TEST_MEMBER_ID` y
   * `STEDI_TEST_MEMBER_DOB` vienen vacíos, y salir a real con ellos manda un
   * 270 lleno de `null` que el pagador rechaza. El resultado en el escenario
   * sería la tarjeta diciendo "no pude verificar" en vez del fixture covered.
   * Es mejor un mock honesto que un real roto.
   */
  const stediMissing: string[] = [];
  if (apiKey === null) stediMissing.push('STEDI_API_KEY');
  if (payerId === null) stediMissing.push('STEDI_TEST_PAYER_ID');
  if (memberId === null) stediMissing.push('STEDI_TEST_MEMBER_ID');
  if (memberDob === null) {
    stediMissing.push(
      memberDobRaw === null
        ? 'STEDI_TEST_MEMBER_DOB'
        : `STEDI_TEST_MEMBER_DOB (no es una fecha usable: "${memberDobRaw}")`,
    );
  }
  const stediConfigured = stediMissing.length === 0;

  // El timeout a Stedi DEBE ser menor que lo que voice/ está dispuesto a
  // esperar; si no, el agente corta antes que nosotros y el paciente se queda
  // colgado sin respuesta.
  if (TIMEOUTS_MS.stediUpstream >= TIMEOUTS_MS.coverageCheck) {
    throw new Error(
      `TIMEOUTS_MS.stediUpstream (${TIMEOUTS_MS.stediUpstream}ms) debe ser menor que ` +
        `TIMEOUTS_MS.coverageCheck (${TIMEOUTS_MS.coverageCheck}ms)`,
    );
  }

  return {
    useMocks: e.USE_MOCKS?.toLowerCase() === 'true' || !stediConfigured,
    stediConfigured,
    stediMissing,
    lang: e.COVERAGE_VOICE_LANG ?? 'es',
    mockScenarioOverride: e.COVERAGE_MOCK_SCENARIO ?? null,
    port: e.PORT ?? PORTS.coverage,
    host: e.HOST ?? '0.0.0.0',
    logLevel: e.LOG_LEVEL ?? 'info',
    version: readPackageVersion(),
    stedi: {
      apiKey,
      environment: e.STEDI_ENV ?? 'sandbox',
      baseUrl: (e.STEDI_BASE_URL ?? DEFAULT_STEDI_BASE_URL).replace(/\/+$/, ''),
      eligibilityPath: e.STEDI_ELIGIBILITY_PATH ?? DEFAULT_STEDI_ELIGIBILITY_PATH,
      authScheme: e.STEDI_AUTH_SCHEME ?? null,
      payerId,
      payerName: e.STEDI_TEST_PAYER_NAME ?? 'Unknown',
      memberId,
      memberFirstName: e.STEDI_TEST_MEMBER_FIRST_NAME ?? null,
      memberLastName: e.STEDI_TEST_MEMBER_LAST_NAME ?? null,
      memberDob,
      providerNpi: e.STEDI_PROVIDER_NPI ?? null,
      providerOrgName: e.STEDI_PROVIDER_ORG_NAME ?? 'Loop Health Demo',
      timeoutMs: TIMEOUTS_MS.stediUpstream,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Arranque del proceso                                                */
/* ------------------------------------------------------------------ */

/**
 * El `.env` se aplica ANTES de leer nada. Si se hiciera después, `loadConfig()`
 * ya habría decidido que no hay `STEDI_API_KEY` y el servicio se quedaría en
 * modo mock con la clave escrita en el archivo: el fallo silencioso que el demo
 * no puede permitirse.
 *
 * Se exporta para que `start()` pueda decir en el log qué archivo se aplicó —
 * un `.env` que no se lee tiene que ser visible, no adivinable.
 */
export const envFile: EnvFileReport = applyEnvFile();

/** Config por defecto del proceso. `buildServer()` acepta otra para los tests. */
export const config: AppConfig = loadConfig();
