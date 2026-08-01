/**
 * Carga del `.env` de la raíz del monorepo — SOLO SERVIDOR.
 *
 * Next solo lee el `.env` que esté dentro de `dashboard/`, y las credenciales de
 * Medplum viven en el `.env` de la RAÍZ, compartido por los cuatro servicios.
 * Sin esto, `MEDPLUM_CLIENT_ID` llega como `undefined`, el expediente cae a
 * fixtures y nadie se entera hasta que en el escenario resulta que la "conexión
 * en vivo a Medplum" era un JSON local. Es el mismo fallo silencioso que
 * `coverage/src/env-file.ts` resuelve para Stedi, y por la misma razón.
 *
 * Este módulo se importa por su EFECTO. `server.ts` lo pone como primer import
 * justamente porque en ESM los imports se evalúan antes del cuerpo del módulo
 * que los importa: para cuando `server.ts` lee `process.env`, esto ya corrió.
 *
 * REGLA: el entorno real del shell SIEMPRE gana sobre el archivo. Un
 * `MEDPLUM_CLIENT_ID=otro npm run dev` no puede quedar anulado por el `.env`.
 */

import 'server-only';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Nombres de variable admitidos. Lo que no encaje se ignora en silencio. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Quita comillas y comentarios de un valor.
 *
 * Solo las comillas dobles interpretan escapes, igual que en un shell. Sin
 * comillas, un `#` precedido de espacio abre un comentario: es la convención que
 * usa el `.env` de este repo, que comenta al final de varias líneas.
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

/** Texto de un `.env` → pares clave/valor. Función pura, exportada para tests. */
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

/**
 * Candidatos, en orden: el primero que exista gana.
 *
 * Se resuelven desde `process.cwd()`, que en `next dev` y `next start` es
 * siempre `dashboard/` — no desde `import.meta.url`, porque Next reubica este
 * módulo dentro de `.next/` y la ruta relativa al fuente deja de valer.
 */
function candidatePaths(): string[] {
  const cwd = process.cwd();
  return [
    join(cwd, '.env'), //        dashboard/.env — anulación local
    join(cwd, '..', '.env'), //  <raíz del repo>/.env — el compartido
  ];
}

let loaded = false;

/**
 * Vuelca el `.env` de la raíz en `process.env` sin pisar lo que venga del shell.
 * Idempotente: en `next dev` este módulo se reevalúa en cada recarga en caliente.
 */
export function loadRepoEnv(): void {
  if (loaded) return;
  loaded = true;

  for (const path of candidatePaths()) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue; // No existe: se prueba el siguiente. Es el caso normal en CI.
    }

    for (const [key, value] of Object.entries(parseEnvFile(text))) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    return;
  }
}

loadRepoEnv();
