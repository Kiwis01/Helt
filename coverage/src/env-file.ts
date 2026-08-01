/**
 * Carga del `.env` sin añadir dependencias.
 *
 * El README manda `cp ops/.env.example .env` y el arranque es `tsx src/server.ts`,
 * que NO lee ese archivo. Sin esto, escribir `STEDI_API_KEY` en el `.env` no
 * tiene ningún efecto: el servicio se queda en modo mock, `/healthz` dice
 * `not-configured` y nadie se entera hasta que la "llamada en vivo a Stedi" del
 * demo resulta ser un fixture. Es el peor fallo posible aquí — silencioso y en
 * el escenario.
 *
 * No se puede instalar `dotenv` (dependencia nueva) ni cambiar el arranque a
 * `node --env-file` (`coverage/package.json` es de solo lectura), así que el
 * parseo vive aquí. Es deliberadamente pequeño: `KEY=VALUE`, comillas, `export`
 * y comentarios. Nada de interpolación de variables ni multilínea — si algún día
 * hace falta, es el momento de meter `dotenv` de verdad.
 *
 * REGLA: el entorno real del shell SIEMPRE gana sobre el archivo. Un
 * `USE_MOCKS=false npm run start` no puede quedar anulado por lo que diga un
 * `.env` olvidado en el disco.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ */
/* Parseo                                                              */
/* ------------------------------------------------------------------ */

/** Nombres de variable admitidos. Lo que no encaje se ignora en silencio. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Quita comillas y comentarios de un valor.
 *
 * Solo las comillas dobles interpretan escapes, igual que en un shell y que en
 * `dotenv`. Sin comillas, un `#` precedido de espacio abre un comentario: es la
 * convención de `ops/.env.example`, que comenta al final de varias líneas.
 */
function unquote(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2) {
    const closing = value.lastIndexOf(quote);
    if (closing > 0) {
      const inner = value.slice(1, closing);
      return quote === '"'
        ? inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"')
        : inner;
    }
  }
  const commentAt = value.search(/\s#/);
  return (commentAt === -1 ? value : value.slice(0, commentAt)).trim();
}

/** Texto de un `.env` → pares clave/valor. Función pura. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const stripped = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separator = stripped.indexOf('=');
    if (separator <= 0) continue; // sin `=` o sin nombre: línea inservible

    const key = stripped.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key)) continue;

    out[key] = unquote(stripped.slice(separator + 1).trim());
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Aplicación                                                          */
/* ------------------------------------------------------------------ */

export interface EnvFileReport {
  /** Archivo aplicado, o `null` si no se aplicó ninguno. */
  path: string | null;
  /** Ruta pedida a mano con `COVERAGE_ENV_FILE`, si la hubo. */
  requestedPath: string | null;
  /** Claves que aportó el archivo. */
  applied: string[];
  /** Claves del archivo que ya venían del shell: el shell manda. */
  skipped: string[];
  /** Por qué no se aplicó nada, cuando `path` es `null`. */
  reason: 'ok' | 'disabled' | 'not-found';
}

export interface ApplyEnvFileOptions {
  /** Ruta explícita. Por defecto se prueban los candidatos habituales. */
  file?: string | null;
  /** Dónde escribir. Por defecto `process.env`; los tests pasan un objeto. */
  target?: NodeJS.ProcessEnv;
}

/**
 * Candidatos, en orden. El primero que exista gana.
 *
 * `coverage/.env` es la anulación local de este servicio; `<raíz>/.env` es el
 * que documenta el README y el que comparten los cuatro servicios.
 */
function candidatePaths(): string[] {
  return [
    fileURLToPath(new URL('../.env', import.meta.url)), // coverage/.env
    fileURLToPath(new URL('../../.env', import.meta.url)), // <raíz del repo>/.env
  ];
}

/** Devuelve el contenido del primer candidato legible, o `null`. */
function readFirstExisting(paths: string[]): { path: string; text: string } | null {
  for (const path of paths) {
    try {
      return { path, text: readFileSync(path, 'utf8') };
    } catch {
      // No existe o no se puede leer: se prueba el siguiente. Que no haya
      // `.env` es el caso normal en CI y en el modo mock.
    }
  }
  return null;
}

/**
 * Lee el `.env` y lo vuelca en `target` sin pisar lo que ya venga del shell.
 *
 * `COVERAGE_ENV_FILE` controla el comportamiento:
 *   - sin definir → candidatos por defecto;
 *   - una ruta    → ese archivo y solo ese;
 *   - `none`      → no se carga nada (lo usa el smoke, que debe ser hermético).
 */
export function applyEnvFile(options: ApplyEnvFileOptions = {}): EnvFileReport {
  const target = options.target ?? process.env;
  const raw = options.file ?? target['COVERAGE_ENV_FILE'] ?? null;
  const requested = raw === null || raw.trim() === '' ? null : raw.trim();

  if (requested !== null && requested.toLowerCase() === 'none') {
    return { path: null, requestedPath: requested, applied: [], skipped: [], reason: 'disabled' };
  }

  const found =
    requested !== null ? readFirstExisting([requested]) : readFirstExisting(candidatePaths());

  if (found === null) {
    // Que no haya `.env` es lo normal (CI, modo mock). Que no exista uno pedido
    // a mano con `COVERAGE_ENV_FILE` es un error de despliegue: por eso se
    // conserva `requestedPath`, para que el arranque pueda gritarlo.
    return { path: null, requestedPath: requested, applied: [], skipped: [], reason: 'not-found' };
  }

  const parsed = parseEnvFile(found.text);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] !== undefined) {
      skipped.push(key);
      continue;
    }
    target[key] = value;
    applied.push(key);
  }

  return { path: found.path, requestedPath: requested, applied, skipped, reason: 'ok' };
}
