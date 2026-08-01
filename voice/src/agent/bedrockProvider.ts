/**
 * Proveedor de LLM sobre AWS Bedrock — Converse API en modo streaming.
 *
 * Por que Bedrock y no la API directa de Anthropic:
 *   el `.env` real del equipo tiene credenciales AWS y `AGENT_MODEL_ID`
 *   (un inference-profile ID ya verificado en esa cuenta). `ANTHROPIC_API_KEY`
 *   esta declarada pero vacia. Bedrock es el camino primario.
 *
 * Reglas de este archivo:
 *   - El modelo se lee SIEMPRE de `config.aws.modelId` (que viene de
 *     `AGENT_MODEL_ID`). Nunca se hardcodea un model id.
 *   - Las credenciales las resuelve la cadena estandar del SDK de AWS desde el
 *     entorno. Este archivo NUNCA lee ni imprime una credencial.
 *   - Si falta el modelId, el proveedor se declara NO disponible en vez de
 *     romper: `voice/src/agent/llm.ts` degrada al proveedor de respaldo.
 *   - Todo lo que se puede probar sin red esta en funciones puras exportadas
 *     (`toConverseInput`, `normalizeMessages`, `extractDeltaText`,
 *     `detectStreamError`, `streamTextDeltas`).
 */

import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ConverseStreamCommandInput,
  type ConverseStreamCommandOutput,
  type ConverseStreamOutput,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';

import { config } from '../config.js';
import type { AgentTurnRequest, LlmProvider } from '../types.js';

// -----------------------------------------------------------------------------
// Parametros de inferencia
// -----------------------------------------------------------------------------

/**
 * Tope de tokens de salida por turno.
 *
 * 400 es BAJO A PROPOSITO: esto es una llamada de voz, no un chat. Una
 * respuesta de 1-2 frases ronda los 40 tokens; 400 deja margen para un turno
 * largo sin permitir que el modelo se lance a un parrafo que el TTS tardaria
 * 30 segundos en locutar. El objetivo de latencia es <800ms de fin-de-habla a
 * inicio-de-respuesta, y un `maxTokens` alto invita justo a lo contrario.
 */
export const MAX_OUTPUT_TOKENS = 400;

/** Temperatura baja: queremos consistencia clinica, no creatividad. */
export const TEMPERATURE = 0.3;

/** Nombre del proveedor que se reporta en logs y en el panel del demo. */
export const BEDROCK_PROVIDER_NAME = 'bedrock-converse';

// -----------------------------------------------------------------------------
// Inyeccion del cliente (para tests sin red)
// -----------------------------------------------------------------------------

/**
 * Superficie minima del cliente de Bedrock que usamos.
 *
 * Se declara asi para poder inyectar un doble en los tests: NUNCA se hace una
 * llamada real a AWS desde el suite.
 */
export interface BedrockClientLike {
  send(
    command: ConverseStreamCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ConverseStreamCommandOutput>;
}

export interface BedrockProviderDeps {
  /** Inference-profile ID. Viene de `AGENT_MODEL_ID`. */
  modelId: string;
  /** Region de AWS. Viene de `AWS_REGION`. */
  region: string;
  /** Fabrica del cliente. Solo se usa en tests; en produccion se omite. */
  createClient?: () => BedrockClientLike;
}

// -----------------------------------------------------------------------------
// Normalizacion de la conversacion
// -----------------------------------------------------------------------------

/** Turno de la conversacion tal y como lo maneja el orquestador. */
type Turn = AgentTurnRequest['messages'][number];

/**
 * Deja la conversacion en la forma que exige Converse:
 *   - sin turnos vacios,
 *   - empezando por `user`,
 *   - alternando roles (los turnos consecutivos del mismo hablante se funden),
 *   - terminando en `user`.
 *
 * Lo ultimo importa: dejar un turno `assistant` al final seria un "prefill",
 * y los modelos recientes de Anthropic lo rechazan con 400. En el flujo de
 * loop-voice nunca deberia pasar (siempre llamamos despues de un turno del
 * paciente), pero un error aqui tiraria la llamada y eso no es aceptable.
 *
 * Funcion pura.
 */
export function normalizeMessages(messages: readonly Turn[]): Turn[] {
  const cleaned: Turn[] = [];

  for (const message of messages) {
    const text = message.text.trim();
    if (text === '') continue;

    const previous = cleaned[cleaned.length - 1];
    if (previous !== undefined && previous.role === message.role) {
      // Turnos consecutivos del mismo hablante: se funden en uno.
      previous.text = `${previous.text}\n${text}`;
      continue;
    }
    cleaned.push({ role: message.role, text });
  }

  // La conversacion tiene que abrir con el paciente.
  while (cleaned.length > 0 && cleaned[0]!.role === 'assistant') {
    cleaned.shift();
  }
  // Y cerrar con el paciente (nada de prefill).
  while (cleaned.length > 0 && cleaned[cleaned.length - 1]!.role === 'assistant') {
    cleaned.pop();
  }

  return cleaned;
}

/**
 * Arma el payload de `ConverseStreamCommand`.
 *
 * Funcion pura: es lo que los tests inspeccionan para verificar el shape sin
 * tocar la red.
 */
export function toConverseInput(
  req: AgentTurnRequest,
  modelId: string,
): ConverseStreamCommandInput {
  const turns = normalizeMessages(req.messages);
  if (turns.length === 0) {
    throw new Error('bedrock: la conversacion no tiene ningun turno del paciente');
  }

  const messages: Message[] = turns.map((turn) => ({
    role: turn.role,
    content: [{ text: turn.text }],
  }));

  return {
    modelId,
    system: [{ text: req.systemPrompt }],
    messages,
    inferenceConfig: {
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: TEMPERATURE,
    },
  };
}

// -----------------------------------------------------------------------------
// Lectura del stream de Converse
// -----------------------------------------------------------------------------

/**
 * Devuelve el texto de un evento `contentBlockDelta`, o null si el evento no
 * transporta texto (arranque de mensaje, cierre de bloque, metadatos...).
 *
 * Funcion pura.
 */
export function extractDeltaText(event: ConverseStreamOutput): string | null {
  const delta = event.contentBlockDelta?.delta;
  if (delta === undefined) return null;
  const text = delta.text;
  return typeof text === 'string' && text !== '' ? text : null;
}

/**
 * Convierte los eventos de error del stream en un `Error` con mensaje util.
 * Devuelve null si el evento no es un error.
 *
 * Bedrock no lanza estos fallos: los entrega EN BANDA, como un evento mas del
 * stream. Si no se inspeccionan, una llamada fallida parece una respuesta
 * vacia y el agente se queda mudo.
 *
 * Funcion pura.
 */
export function detectStreamError(event: ConverseStreamOutput): Error | null {
  const cases: Array<[string, { message?: string } | undefined]> = [
    ['internalServerException', event.internalServerException],
    ['modelStreamErrorException', event.modelStreamErrorException],
    ['validationException', event.validationException],
    ['throttlingException', event.throttlingException],
    ['serviceUnavailableException', event.serviceUnavailableException],
  ];

  for (const [name, payload] of cases) {
    if (payload !== undefined) {
      return new Error(`bedrock ${name}: ${payload.message ?? 'sin detalle'}`);
    }
  }
  return null;
}

/**
 * Recorre el stream de Converse y emite SOLO los deltas de texto.
 *
 * - `messageStop` cierra el turno y termina el generador.
 * - Un evento de error se convierte en `Error` y se lanza.
 * - Si el `AbortSignal` se dispara (p.ej. una red-flag corto el turno a mitad)
 *   se deja de emitir de inmediato.
 *
 * No hace I/O propio: recibe el iterable ya abierto, asi que se puede probar
 * con un stream simulado.
 */
export async function* streamTextDeltas(
  stream: AsyncIterable<ConverseStreamOutput>,
  signal?: AbortSignal,
): AsyncIterable<string> {
  for await (const event of stream) {
    if (signal?.aborted === true) return;

    const failure = detectStreamError(event);
    if (failure !== null) throw failure;

    const text = extractDeltaText(event);
    if (text !== null) yield text;

    if (event.messageStop !== undefined) return;
  }
}

// -----------------------------------------------------------------------------
// El proveedor
// -----------------------------------------------------------------------------

/**
 * Construye el proveedor de Bedrock.
 *
 * El cliente se crea de forma perezosa (en la primera llamada) para que
 * importar este modulo no tenga efectos de red ni de credenciales.
 */
export function createBedrockProvider(deps: BedrockProviderDeps): LlmProvider {
  let client: BedrockClientLike | null = null;

  function getClient(): BedrockClientLike {
    if (client === null) {
      client =
        deps.createClient !== undefined
          ? deps.createClient()
          : // Las credenciales las resuelve la cadena estandar de AWS desde el
            // entorno. Nunca las leemos ni las logueamos aqui.
            new BedrockRuntimeClient({ region: deps.region });
    }
    return client;
  }

  return {
    name: BEDROCK_PROVIDER_NAME,

    async *streamReply(req: AgentTurnRequest, signal?: AbortSignal): AsyncIterable<string> {
      if (signal?.aborted === true) return;

      const command = new ConverseStreamCommand(toConverseInput(req, deps.modelId));
      const response = await getClient().send(command, { abortSignal: signal });

      const stream = response.stream;
      if (stream === undefined) {
        throw new Error('bedrock: la respuesta de ConverseStream no trae stream');
      }

      yield* streamTextDeltas(stream, signal);
    },
  };
}

/**
 * Proveedor de Bedrock construido desde la configuracion del proceso, o null
 * si no hay `AGENT_MODEL_ID`. "No disponible" nunca es una excepcion: es un
 * null que el selector de `llm.ts` sabe manejar.
 */
export function createBedrockProviderFromConfig(): LlmProvider | null {
  const modelId = config.aws.modelId;
  if (modelId === undefined || modelId === '') return null;
  return createBedrockProvider({ modelId, region: config.aws.region });
}
