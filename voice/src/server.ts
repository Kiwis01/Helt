/**
 * loop-voice — servidor. Puerto 3002 (`VOICE_PORT`, NUNCA `PORT`).
 *
 * Monta, en este orden:
 *   - CORS (el dashboard de Carlos vive en :3000 y consume el SSE de aqui)
 *   - WebSocket (@fastify/websocket) — tiene que registrarse ANTES de las rutas
 *     que declaran `{ websocket: true }`
 *   - Estatico: `voice/public` en `/` (el cliente push-to-talk del Agente G)
 *   - /healthz, /api/v1/status, /api/v1/call/*, /api/v1/debug/*, /api/v1/live/*
 *
 * Al arrancar hace tres cosas antes de escuchar:
 *   1. `assertConfig()` — avisa de cada credencial que falta y de que se pierde
 *      con ella. Nunca lanza: el motor de red-flags no necesita ninguna.
 *   2. `warmContext()` — paga el viaje a :3001 ahora, no durante el primer turno
 *      del paciente. Primera palanca de latencia del brief.
 *   3. Pre-sintetiza los textos fijos (disclosure, guiones 911/988, frase
 *      puente) para que entren en la cache LRU del TTS. La escalacion tiene que
 *      sonar instantanea, y sonara instantanea porque ya esta en memoria.
 */

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getActiveProviderName, getLlmProvider } from './agent/llm.js';
import { synthesize } from './audio/tts.js';
import { getContextSource, warmContext } from './clients/coreClient.js';
import { assertConfig, config } from './config.js';
import { registerSseRoutes, STREAM_PATH } from './live/sse.js';
import { describeError, log } from './logger.js';
import { endAllCalls } from './orchestrator/callOrchestrator.js';
import { BRIDGE_LINE, toSpeakableChunks } from './orchestrator/turnPipeline.js';
import { registerCallRoutes, WS_PATH_PRIMARY } from './routes/call.js';
import { registerDebugRoutes } from './routes/debug.js';
import { registerHealthRoutes } from './routes/health.js';
import { OPENING_DISCLOSURE, RED_FLAG_RULES, SCRIPT_911, SCRIPT_988 } from './safety/index.js';

const here = dirname(fileURLToPath(import.meta.url)); // <repo>/voice/src
const PUBLIC_DIR = resolve(here, '../public');

// -----------------------------------------------------------------------------
// CORS
// -----------------------------------------------------------------------------

/**
 * Abierto a localhost en cualquier puerto.
 *
 * Los origenes que importan son :3000 (dashboard) y :3002 (esta misma pagina),
 * pero durante un hackathon el dashboard acaba en :5173, en :3001 o en la IP de
 * la red local mas de una vez. Bloquear un origen local no protege de nada aqui
 * —el servicio corre en la laptop del demo— y si cuesta veinte minutos de
 * depuracion en el peor momento posible. Peticiones sin `Origin` (curl, un
 * script) tambien pasan.
 */
function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0.0.0.0' ||
      hostname.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Construccion
// -----------------------------------------------------------------------------

export interface BuildServerOptions {
  /** Pre-sintetizar los textos fijos al arrancar. Default true. */
  warmTts?: boolean;
  /** Precargar el contexto del paciente. Default true. */
  warmContext?: boolean;
}

/**
 * Construye la instancia de Fastify con todo montado, sin escuchar todavia.
 * La usan `start()` y `scripts/smoke.ts`.
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // El log de la app va por `src/logger.ts` (estructurado y legible en el
    // escenario). El de Fastify solo añadiria ruido por encima.
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: (origin, cb) => cb(null, origin === undefined || isLocalOrigin(origin)),
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: false,
  });

  await app.register(websocket, {
    options: {
      // Un turno de PCM a 16 kHz son 3200 bytes por frame; 1 MB es holgado y
      // acota lo que un cliente roto puede empujar de golpe.
      maxPayload: 1024 * 1024,
    },
  });

  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });

  registerHealthRoutes(app);
  registerCallRoutes(app);
  registerDebugRoutes(app);
  registerSseRoutes(app);

  app.setErrorHandler((error: unknown, request, reply) => {
    const message = describeError(error);
    const status =
      typeof error === 'object' && error !== null && typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    log.error('http.error', { method: request.method, url: request.url, message });
    reply.code(status).send({ error: 'error-interno', message });
  });

  if (options.warmContext !== false) {
    // `warmContext` nunca lanza: la cadena de degradacion termina en un contexto
    // embebido. El try es por si alguien cambia eso mañana.
    try {
      await warmContext(config.patientId);
    } catch (err) {
      log.warn('context.warm-failed', { message: describeError(err) });
    }
  }

  if (options.warmTts !== false) void warmFixedLines();

  return app;
}

/**
 * Mete los textos fijos en la cache LRU del TTS.
 *
 * Se calientan los MISMOS FRAGMENTOS que va a pedir el pipeline, no los guiones
 * enteros: el TTS se invoca por frase (es la palanca de latencia) y la clave de
 * la cache es el texto exacto. Calentar el guion completo llenaria la cache de
 * entradas que nadie va a volver a pedir.
 *
 * Las frases se sintetizan en paralelo y no se espera al resultado (`void` en
 * quien llama): el servidor ya esta escuchando. Lo que se gana es que los dos
 * guiones de escalacion esten en memoria antes de que nadie los necesite —
 * cuando el motor dispara, la voz tiene que salir instantanea.
 */
async function warmFixedLines(): Promise<void> {
  if (!config.deepgram.apiKey && !config.aws.accessKeyId) return; // no hay TTS que calentar

  const lines = [SCRIPT_911, SCRIPT_988, OPENING_DISCLOSURE, BRIDGE_LINE];
  const chunks = (await Promise.all(lines.map(toSpeakableChunks))).flat();

  const started = Date.now();
  let ok = 0;

  // Concurrencia limitada. Disparar los 17 fragmentos de golpe le saca un 429 a
  // Deepgram, y esos fragmentos caen a Polly y se cachean con OTRA voz: el
  // guion del 911 acabaria sonando mitad Aura-2 mitad Polly. Prefiero que el
  // pre-calentado tarde diez segundos mas en segundo plano.
  const BATCH = 3;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map((chunk) => synthesize(chunk)));
    ok += results.filter((r) => r.status === 'fulfilled' && r.value.provider !== 'none').length;
  }

  log.info('tts.warm-complete', { chunks: chunks.length, ok, ms: Date.now() - started });
}

// -----------------------------------------------------------------------------
// Banner
// -----------------------------------------------------------------------------

function printBanner(): void {
  const base = `http://localhost:${config.port}`;
  const tts = config.deepgram.apiKey
    ? 'Deepgram Aura-2'
    : config.aws.accessKeyId
      ? 'AWS Polly (respaldo)'
      : 'NINGUNO (la llamada sigue, muda)';

  const lines = [
    '',
    '  ┌──────────────────────────────────────────────────────────────┐',
    '  │  loop-voice · agente de voz + motor de red-flags             │',
    '  └──────────────────────────────────────────────────────────────┘',
    `   puerto        ${config.port}   (VOICE_PORT — nunca PORT)`,
    `   mocks         ${config.useMocks ? 'SI  (lee shared/fixtures/)' : 'NO  (:3001 y :3003 en vivo)'}`,
    `   contexto      ${getContextSource()}`,
    `   LLM           ${getLlmProvider().name}${config.aws.modelId ? '' : '  (sin AGENT_MODEL_ID)'}`,
    `   TTS           ${tts}`,
    `   STT           ${config.deepgram.apiKey ? `Deepgram ${config.deepgram.sttModel} (${config.deepgram.sttLanguage})` : 'NO (usa el modo texto)'}`,
    `   red-flags     ${RED_FLAG_RULES.length} reglas deterministas, activas siempre`,
    '',
    `   cliente       ${base}/`,
    `   salud         ${base}/healthz`,
    `   estado        ${base}/api/v1/status`,
    `   SSE (Carlos)  ${base}${STREAM_PATH}`,
    `   WebSocket     ws://localhost:${config.port}${WS_PATH_PRIMARY}`,
    '',
    '   probar una regla sin microfono:',
    `     curl -s ${base}/api/v1/debug/redflag -H 'content-type: application/json' \\`,
    `          -d '{"text":"me duele el pecho y se me va al brazo"}'`,
    '',
  ];
  console.log(lines.join('\n'));
}

// -----------------------------------------------------------------------------
// Arranque y apagado
// -----------------------------------------------------------------------------

/**
 * Comprueba que quien contesta en `localhost:<puerto>` somos NOSOTROS.
 *
 * Windows deja que un proceso escuche en `0.0.0.0:3002` mientras otro ya tiene
 * `127.0.0.1:3002`, y el trafico a `localhost` se lo lleva el enlace mas
 * especifico: el otro. Es decir, `listen()` dice que todo fue bien, el banner
 * sale, y el dashboard recibe 404 desde un servidor fantasma que nadie recuerda
 * haber dejado abierto. Paso de verdad durante la integracion, con un servidor
 * de pruebas olvidado de otra sesion.
 *
 * Cuesta una peticion HTTP a nosotros mismos y convierte veinte minutos de
 * depuracion a ciegas en una linea roja en el arranque.
 */
async function verifyPortOwnership(): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = (await res.json()) as { service?: unknown };
    if (body.service === 'loop-voice') return;

    console.error(
      `\n  ⚠  OTRO PROCESO responde en localhost:${config.port} (service=${String(body.service)}).\n` +
        `     loop-voice escucha en ${config.host}:${config.port} pero el trafico a localhost va al otro.\n` +
        `     Cierralo antes del demo:  npx kill-port ${config.port}\n`,
    );
  } catch (err) {
    console.error(
      `\n  ⚠  No pude verificar quien responde en localhost:${config.port} (${describeError(err)}).\n` +
        '     Comprueba a mano que /healthz devuelve service=loop-voice.\n',
    );
  }
}

export async function start(): Promise<FastifyInstance> {
  assertConfig();

  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });

  await verifyPortOwnership();
  printBanner();
  log.info('server.listening', {
    port: config.port,
    host: config.host,
    useMocks: config.useMocks,
    llm: getActiveProviderName(),
  });

  installShutdown(app);
  return app;
}

let shuttingDown = false;

/**
 * Apagado limpio.
 *
 * Lo importante es `endAllCalls`: una llamada viva en el momento del Ctrl+C
 * todavia no ha escrito su episodio, y ese episodio es el unico registro
 * duradero de lo que paso. Se escribe antes de cerrar el servidor.
 */
function installShutdown(app: FastifyInstance): void {
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('server.shutdown', { signal });

    void (async () => {
      try {
        const ended = await endAllCalls(`apagado (${signal})`);
        if (ended.length > 0) log.info('server.calls-closed', { count: ended.length });
      } catch (err) {
        log.error('server.shutdown-failed', { message: describeError(err) });
      }
      try {
        await app.close();
      } catch (err) {
        log.error('server.close-failed', { message: describeError(err) });
      }
      process.exit(0);
    })();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// -----------------------------------------------------------------------------
// Punto de entrada
// -----------------------------------------------------------------------------

/** True si este archivo se ejecuto directamente (`tsx src/server.ts`). */
function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  start().catch((err: unknown) => {
    console.error('[server] no se pudo arrancar:', describeError(err));
    process.exit(1);
  });
}
