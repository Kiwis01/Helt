/**
 * loop-coverage — servidor Fastify. Puerto 3003 (PORTS.coverage).
 *
 * `buildServer()` acepta una config inyectada para poder levantar variantes en
 * el mismo proceso (lo usa `scripts/smoke.ts` para probar el fallback de Stedi
 * sin necesidad de credenciales ni de otra terminal).
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';

import { ApiError, PORTS } from '@loop/shared';

import { config as defaultConfig, envFile, type AppConfig } from './config.js';
import { registerHealthRoute } from './routes/health.js';
import { COVERAGE_CHECK_PATH, newCheckId, registerCoverageCheckRoute, unknownResponse } from './routes/check.js';

/** Quién puede llamarnos desde un navegador: el dashboard y voice/. */
export const CORS_ORIGINS = [
  `http://localhost:${PORTS.dashboard}`, // 3000 — loop-dashboard
  `http://localhost:${PORTS.voice}`, // 3002 — loop-voice
];

export async function buildServer(cfg: AppConfig = defaultConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: cfg.logLevel } });

  await app.register(cors, {
    origin: CORS_ORIGINS,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  /**
   * Cualquier error que escape de una ruta pasa por aquí.
   *
   * En `/api/v1/coverage/check` un 5xx es inaceptable: hay una llamada de voz
   * en curso. Se degrada a 200 + status "unknown". En el resto del servicio un
   * error se reporta con la forma `ApiError` compartida.
   */
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = error.statusCode ?? 500;

    if (request.url.startsWith(COVERAGE_CHECK_PATH) && statusCode >= 500) {
      request.log.error({ err: error }, 'error no controlado en coverage check — degradando a unknown');
      return reply.code(200).send(unknownResponse(newCheckId(), 0, cfg));
    }

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'error no controlado');
    }

    const body: ApiError = {
      error: error.code ?? (statusCode >= 500 ? 'internal_error' : 'bad_request'),
      message: statusCode >= 500 ? 'Error interno de loop-coverage.' : error.message,
    };
    return reply.code(statusCode).send(ApiError.parse(body));
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ApiError = {
      error: 'not_found',
      message: `No existe ${request.method} ${request.url} en loop-coverage.`,
    };
    return reply.code(404).send(ApiError.parse(body));
  });

  registerHealthRoute(app, cfg);
  registerCoverageCheckRoute(app, cfg);

  return app;
}

export async function start(cfg: AppConfig = defaultConfig): Promise<FastifyInstance> {
  const app = await buildServer(cfg);
  await app.listen({ port: cfg.port, host: cfg.host });

  app.log.info(
    {
      port: cfg.port,
      mode: cfg.useMocks ? 'mock' : 'stedi',
      stediConfigured: cfg.stediConfigured,
      lang: cfg.lang,
      stediTimeoutMs: cfg.stedi.timeoutMs,
      envFile: envFile.path,
    },
    'loop-coverage arriba',
  );

  /*
   * Estos dos avisos existen para que el modo mock nunca sea una sorpresa.
   * El día del demo la pregunta es "¿esto va a Stedi de verdad?", y la
   * respuesta tiene que estar en el log del arranque, no en la cara de los
   * jueces.
   */
  if (envFile.requestedPath !== null && envFile.path === null && envFile.reason === 'not-found') {
    app.log.warn(
      { requested: envFile.requestedPath },
      'COVERAGE_ENV_FILE apunta a un archivo que no existe — no se cargó ninguna variable',
    );
  }

  if (cfg.stediMissing.length > 0) {
    app.log.warn(
      { missing: cfg.stediMissing, envFile: envFile.path },
      'Stedi incompleto: el servicio responde desde fixtures. Con estas variables puestas sale a real.',
    );
  }

  return app;
}

/* ------------------------------------------------------------------ */
/* Arranque solo cuando este archivo es el punto de entrada            */
/* ------------------------------------------------------------------ */

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  start().catch((error: unknown) => {
    console.error('loop-coverage no pudo arrancar:', error);
    process.exit(1);
  });
}
