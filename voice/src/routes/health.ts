/**
 * Salud y estado del servicio.
 *
 *   GET /healthz          respuesta corta, la que mira un script o un juez
 *   GET /api/v1/status    el detalle del runbook (T-5 minutos del demo)
 *
 * REGLA: ninguna de las dos imprime el VALOR de una credencial. Solo si esta
 * presente o no, porque eso es lo unico que hace falta para diagnosticar por que
 * el agente no habla, y porque estas rutas estan abiertas en el CORS del demo.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { getActiveProviderName, getLlmProvider } from '../agent/llm.js';
import { getContextSource } from '../clients/coreClient.js';
import { config, loadedEnvPath } from '../config.js';
import { bufferedCount, subscriberCount } from '../live/bus.js';
import { recentLogs } from '../logger.js';
import { activeCallCount, currentCall } from '../orchestrator/callOrchestrator.js';
import { FORBIDDEN_PATTERN_COUNT, RED_FLAG_RULES } from '../safety/index.js';
import { ttsCacheSize } from '../audio/tts.js';
import { sessionStore } from '../session/sessionStore.js';

/** Hay credenciales de AWS para Bedrock (LLM) y Polly (TTS de respaldo). */
function hasAws(): boolean {
  return Boolean(config.aws.accessKeyId && config.aws.secretAccessKey);
}

const startedAt = Date.now();

function handleHealthz(_req: FastifyRequest, reply: FastifyReply): void {
  // `getLlmProvider()` esta memoizado y construye su cliente de AWS de forma
  // perezosa: llamarlo aqui no cuesta red y ademas deja `getActiveProviderName`
  // apuntando al proveedor real en vez de a su valor inicial.
  const configured = getLlmProvider().name;

  reply.send({
    ok: true,
    service: 'loop-voice',
    port: config.port,
    useMocks: config.useMocks,
    contextSource: getContextSource(),
    llmProvider: getActiveProviderName() === configured ? configured : `${configured} → ${getActiveProviderName()}`,
    deepgram: Boolean(config.deepgram.apiKey),
    polly: hasAws(),
    activeCalls: activeCallCount(),
  });
}

/**
 * Estado extendido. Contesta las preguntas que uno se hace con el publico ya
 * sentado: ¿de donde sale el contexto?, ¿que motor esta hablando?, ¿hay voz?,
 * ¿el dashboard esta enganchado al stream?
 *
 * `?logs=1` añade los ultimos eventos estructurados del proceso. Es mas rapido
 * que buscar en el scrollback de la terminal.
 */
function handleStatus(req: FastifyRequest, reply: FastifyReply): void {
  const query = (req.query ?? {}) as Record<string, unknown>;
  const wantsLogs = query['logs'] === '1' || query['logs'] === 'true';
  const call = currentCall();

  reply.send({
    ok: true,
    service: 'loop-voice',
    version: '0.1.0',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    config: {
      port: config.port,
      host: config.host,
      useMocks: config.useMocks,
      language: config.language,
      coreUrl: config.coreUrl,
      coverageUrl: config.coverageUrl,
      patientId: config.patientId,
      envFile: loadedEnvPath,
      timeouts: config.timeouts,
    },
    // Presencia, nunca valor.
    credentials: {
      deepgram: Boolean(config.deepgram.apiKey),
      awsBedrock: hasAws() && Boolean(config.aws.modelId),
      awsPolly: hasAws(),
      agentModelConfigured: Boolean(config.aws.modelId),
    },
    audio: {
      sttModel: config.deepgram.sttModel,
      sttLanguage: config.deepgram.sttLanguage,
      ttsVoice: config.deepgram.ttsVoice,
      pollyVoice: config.polly.voice,
      pollyEngine: config.polly.engine,
      ttsCacheEntries: ttsCacheSize(),
    },
    llm: {
      configured: getLlmProvider().name,
      active: getActiveProviderName(),
      region: config.aws.region,
      // El id del modelo no es un secreto y hace falta para depurar Bedrock.
      modelId: config.aws.modelId ?? null,
    },
    safety: {
      rules: RED_FLAG_RULES.length,
      ruleIds: RED_FLAG_RULES.map((rule) => rule.id),
      outputFilterPatterns: FORBIDDEN_PATTERN_COUNT,
      note: 'El motor corre ANTES del LLM en cada turno. Sin credenciales sigue funcionando.',
    },
    context: { source: getContextSource() },
    live: { subscribers: subscriberCount(), buffered: bufferedCount() },
    calls: {
      active: activeCallCount(),
      retained: sessionStore.size,
      current: call === null ? null : call.session.snapshot(),
    },
    ...(wantsLogs ? { logs: recentLogs(50) } : {}),
  });
}

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', handleHealthz);
  app.get('/api/v1/status', handleStatus);
}
