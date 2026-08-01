/**
 * Configuración del dashboard leída del entorno.
 *
 * Nombres exactos de `ops/.env.example`. Todas llevan prefijo `NEXT_PUBLIC_`
 * porque este código corre también en el navegador.
 *
 * Las variables se leen con acceso literal a `process.env.NEXT_PUBLIC_X`, no
 * con índice dinámico: Next las sustituye por su valor en tiempo de build
 * mediante reemplazo textual, y `process.env[nombre]` no se sustituye nunca.
 */

import { DEFAULT_SERVICE_URLS, LOOP_PATIENT_ID } from '@loop/shared/constants';

/** Quita la barra final para que concatenar rutas no produzca `//api`. */
function normalizeUrl(value: string | undefined, fallback: string): string {
  const raw = (value ?? '').trim();
  return (raw === '' ? fallback : raw).replace(/\/+$/, '');
}

/**
 * Modo respaldo global. En `true` el dashboard ni siquiera intenta la red:
 * es la palanca que se acciona si el wifi del hackathon muere a mitad del
 * demo. Cualquier valor distinto de "true" se interpreta como false.
 */
const useFixtures = (process.env.NEXT_PUBLIC_USE_FIXTURES ?? '').trim().toLowerCase() === 'true';

export const config = {
  /** loop-core (Kiwis) — Contratos 4 y 6. */
  coreUrl: normalizeUrl(process.env.NEXT_PUBLIC_LOOP_CORE_URL, DEFAULT_SERVICE_URLS.core),
  /** loop-voice (Lewis) — Contrato 5, el SSE. Lo consume la Fase 3. */
  voiceUrl: normalizeUrl(process.env.NEXT_PUBLIC_LOOP_VOICE_URL, DEFAULT_SERVICE_URLS.voice),
  /** loop-coverage (Carlos) — Contrato 3. */
  coverageUrl: normalizeUrl(process.env.NEXT_PUBLIC_LOOP_COVERAGE_URL, DEFAULT_SERVICE_URLS.coverage),
  useFixtures,
  patientId: (process.env.NEXT_PUBLIC_LOOP_PATIENT_ID ?? '').trim() || LOOP_PATIENT_ID,
} as const;

export type LoopConfig = typeof config;
