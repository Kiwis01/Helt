/**
 * Rutas de depuracion y de demostracion.
 *
 *   POST /api/v1/debug/redflag   una frase -> el `RedFlagResult` crudo
 *   POST /api/v1/debug/tts       un texto  -> el audio, para probar la voz
 *
 * La primera es la que se le enseña a un juez que pregunta "¿y como se yo que
 * eso es una regla y no el modelo?". La respuesta cabe en un curl: no lleva
 * credenciales, no toca la red, no hay LLM en el camino, y el veredicto es
 * byte a byte el mismo que produce la llamada en vivo — porque literalmente es
 * la misma funcion (`safety/index.ts -> evaluate`), no una copia para el demo.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { synthesize } from '../audio/tts.js';
import { getPatientContext } from '../clients/coreClient.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { RED_FLAG_RULES, RULES_IN_EVALUATION_ORDER, evaluate } from '../safety/index.js';
import type { CurrentBiometrics } from '../types.js';

// -----------------------------------------------------------------------------
// POST /api/v1/debug/redflag
// -----------------------------------------------------------------------------

const redFlagBodySchema = z.object({
  text: z.string().default(''),
  /** Frecuencia cardiaca simulada (bpm). Dispara RF-08 por encima del envelope. */
  hr: z.number().optional(),
  /** Respiraciones por minuto simuladas. */
  rr: z.number().optional(),
  /** Variabilidad cardiaca simulada (ms). */
  hrv: z.number().optional(),
  /** 'cardiac-redflag' carga el contexto con la biometria critica del fixture. */
  profile: z.string().optional(),
});

/**
 * Sustituye una lectura conservando el resto del contrato.
 *
 * `latest` y el extremo de la ventana (`max` / `min`) se mueven JUNTOS a
 * proposito: `checkEnvelope` mira los dos, y si solo cambiaramos `latest` un
 * `hr: 30` seguiria arrastrando el `max: 126` del fixture y el resultado del
 * debug no coincidiria con lo que hace el motor en vivo.
 */
function overrideBiometrics(
  base: CurrentBiometrics,
  overrides: { hr?: number; rr?: number; hrv?: number },
): CurrentBiometrics {
  const next = structuredClone(base) as CurrentBiometrics;

  if (typeof overrides.hr === 'number' && Number.isFinite(overrides.hr)) {
    next.heartRate = { ...next.heartRate, latest: overrides.hr, max: overrides.hr };
  }
  if (typeof overrides.rr === 'number' && Number.isFinite(overrides.rr)) {
    next.respiratoryRate = {
      ...next.respiratoryRate,
      latest: overrides.rr,
      max: overrides.rr,
    };
  }
  if (typeof overrides.hrv === 'number' && Number.isFinite(overrides.hrv)) {
    next.hrv = { ...next.hrv, latest: overrides.hrv, min: overrides.hrv };
  }
  return next;
}

async function handleRedFlag(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = redFlagBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.code(400).send({
      error: 'body-invalido',
      hint: '{ "text": "...", "hr": 163, "rr": 34, "hrv": 12, "profile": "cardiac-redflag" }',
    });
    return;
  }

  const body = parsed.data;
  const ctx = await getPatientContext(config.patientId, { profile: body.profile });
  const biometrics = overrideBiometrics(ctx.current, body);

  const result = evaluate({
    transcriptText: body.text,
    biometrics,
    safetyEnvelope: ctx.safetyEnvelope,
  });

  log.info('debug.redflag', {
    triggered: result.triggered,
    rule: result.ruleId,
    hr: biometrics.heartRate.latest,
    rr: biometrics.respiratoryRate.latest,
  });

  reply.send({
    input: {
      text: body.text,
      biometrics: {
        heartRate: biometrics.heartRate.latest,
        heartRateMax: biometrics.heartRate.max,
        hrv: biometrics.hrv.latest,
        respiratoryRate: biometrics.respiratoryRate.latest,
      },
      safetyEnvelope: ctx.safetyEnvelope,
    },
    result,
    engine: {
      rules: RED_FLAG_RULES.length,
      evaluationOrder: RULES_IN_EVALUATION_ORDER.map((rule) => rule.id),
      deterministic: true,
      llmInvolved: false,
      note: 'Misma funcion que usa la llamada en vivo. Sin red, sin credenciales, sin modelo.',
    },
  });
}

// -----------------------------------------------------------------------------
// POST /api/v1/debug/tts
// -----------------------------------------------------------------------------

const ttsBodySchema = z.object({ text: z.string().min(1) });

/**
 * Devuelve el audio de un texto. Sirve para dos cosas antes del demo: comprobar
 * que la voz suena como queremos, y ver de que proveedor salio (Deepgram o el
 * respaldo de Polly) sin tener que descolgar una llamada.
 *
 * `synthesize` nunca lanza: si ningun proveedor responde devuelve un buffer
 * vacio con `provider: 'none'`, y aqui eso sale como 503 con el detalle en las
 * cabeceras, no como una excepcion.
 */
async function handleTts(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = ttsBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.code(400).send({ error: 'body-invalido', hint: '{ "text": "hola" }' });
    return;
  }

  const result = await synthesize(parsed.data.text);

  reply
    .header('X-Tts-Provider', result.provider)
    .header('X-Tts-Latency-Ms', String(result.latencyMs))
    .header('X-Tts-Bytes', String(result.audio.length));

  if (result.provider === 'none' || result.audio.length === 0) {
    reply.code(503).send({
      error: 'sin-tts',
      provider: result.provider,
      latencyMs: result.latencyMs,
      hint: 'Ni Deepgram ni Polly respondieron. La llamada seguiria viva, solo muda.',
    });
    return;
  }

  reply.header('Content-Type', result.contentType).send(result.audio);
}

// -----------------------------------------------------------------------------

export function registerDebugRoutes(app: FastifyInstance): void {
  app.post('/api/v1/debug/redflag', handleRedFlag);
  app.post('/api/v1/debug/tts', handleTts);
}
