import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { NextConfig } from 'next';

/* ==================================================================== */
/* Carga del `.env` de la raíz                                          */
/* ==================================================================== */

/**
 * Next SOLO lee archivos `.env` que estén dentro de `dashboard/`, y este repo
 * tiene un único `.env` en la raíz (`cp ops/.env.example .env`). Sin esto,
 * `NEXT_PUBLIC_USE_FIXTURES=true` —el modo respaldo si muere el wifi— no llega
 * nunca al bundle: se escribe en el `.env`, se reconstruye y no pasa nada. Hoy
 * no se nota porque `src/lib/config.ts` cae a `DEFAULT_SERVICE_URLS` y los
 * valores coinciden, que es justo lo que hace el fallo peligroso: la palanca
 * del plan B parece existir.
 *
 * Es el mismo problema que resuelve `coverage/src/env-file.ts` en el servicio
 * hermano, con las mismas reglas de parseo. Se duplica el parser porque
 * `dashboard/` no puede importar de `coverage/`.
 *
 * DOS REGLAS:
 *
 * 1. El shell SIEMPRE gana. `NEXT_PUBLIC_USE_FIXTURES=true npm run build` no
 *    puede quedar anulado por un `.env` viejo en el disco.
 * 2. Solo se aplican variables `NEXT_PUBLIC_*`. El dashboard corre en el
 *    navegador y no lee ninguna otra (ver `src/lib/config.ts`); meter en este
 *    proceso el `STEDI_API_KEY` o el `MEDPLUM_CLIENT_SECRET` del `.env`
 *    compartido sería exposición gratuita.
 */

/** Nombres de variable admitidos. Lo que no encaje se ignora en silencio. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Quita comillas y comentarios de un valor. Solo las comillas dobles
 * interpretan escapes, igual que en un shell. Sin comillas, un `#` precedido de
 * espacio abre comentario: es la convención de `ops/.env.example`, que comenta
 * al final de varias líneas.
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
function parseEnvFile(text: string): Record<string, string> {
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
 * Candidatos, en orden. El primero que exista gana.
 *
 * Se resuelven desde `process.cwd()` —que para `next dev`, `next build` y
 * `next start` es siempre `dashboard/`— y no desde `import.meta.url`: Next
 * transpila este archivo a un temporal antes de ejecutarlo, así que la ruta del
 * módulo no apunta a donde uno cree.
 *
 * `DASHBOARD_ENV_FILE` fuerza una ruta concreta, o `none` para no cargar nada
 * (mismo contrato que `COVERAGE_ENV_FILE` en el servicio hermano).
 */
function candidatePaths(): string[] {
  const requested = (process.env['DASHBOARD_ENV_FILE'] ?? '').trim();
  if (requested.toLowerCase() === 'none') return [];
  if (requested !== '') return [resolve(process.cwd(), requested)];

  return [
    resolve(process.cwd(), '.env'), // dashboard/.env — anulación local
    resolve(process.cwd(), '..', '.env'), // <raíz del repo>/.env — el compartido
  ];
}

/** Aplica el primer `.env` legible. Devuelve la línea que se imprime al arrancar. */
function applyPublicEnv(): string | null {
  for (const path of candidatePaths()) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue; // No existe: se prueba el siguiente. Sin `.env` es lo normal en CI.
    }

    const applied: string[] = [];
    for (const [key, value] of Object.entries(parseEnvFile(text))) {
      if (!key.startsWith('NEXT_PUBLIC_')) continue;
      if (process.env[key] !== undefined) continue; // el shell manda
      process.env[key] = value;
      applied.push(key);
    }

    // `next build` levanta procesos hijo que heredan el entorno ya aplicado: en
    // esos, 0 aplicadas no significa que el archivo esté vacío. Se dice cuál es
    // el caso para que la línea no se lea como un fallo.
    return applied.length > 0
      ? `${path} · ${applied.length} variables NEXT_PUBLIC_`
      : `${path} · sin cambios (ya venían del entorno)`;
  }

  return null;
}

// Se ejecuta al cargar la config, antes de que webpack construya el DefinePlugin
// que mete las NEXT_PUBLIC_ en el bundle del navegador.
//
// Se imprime siempre —también cuando no hay archivo— porque el modo respaldo se
// acciona con prisa y delante de gente: hay que poder confirmar de un vistazo
// QUÉ `.env` mandó en este build.
console.log(`[loop-dashboard] .env → ${applyPublicEnv() ?? 'ninguno (solo entorno del shell)'}`);

/* ==================================================================== */

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // `@loop/shared` se publica como TypeScript crudo (main: ./index.ts) y vive
  // fuera de dashboard/. Sin transpilePackages, webpack lo trata como JS ya
  // compilado de node_modules y el build falla en el primer `import type`.
  transpilePackages: ['@loop/shared'],

  // No hay ESLint instalado en el workspace y el script `lint` es opcional.
  // Sin esto, `next build` puede intentar resolver una config que no existe.
  eslint: { ignoreDuringBuilds: true },

  // Los errores de tipos SÍ tienen que romper el build: es la única red de
  // seguridad contra un cambio de contrato en shared/ que nadie avisó.
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
