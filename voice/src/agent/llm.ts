/**
 * Seleccion del proveedor de LLM.
 *
 * Regla de oro de loop-voice: LA LLAMADA NUNCA SE CAE. Aplicada aqui, eso
 * significa que un fallo del modelo no puede dejar al agente mudo. La cadena es:
 *
 *   AGENT_MODEL_ID presente -> Bedrock Converse (streaming)
 *                              |  si lanza antes de emitir un solo delta
 *                              v
 *   proveedor `scripted`    -> respuesta plantillada, determinista, sin red,
 *                              armada con los numeros reales del contexto.
 *
 * El respaldo NO es un placeholder: dice el ritmo actual, el de referencia y la
 * siguiente actividad del care plan. Si Bedrock se cae en mitad del demo, el
 * agente sigue diciendo algo defendible.
 *
 * `getActiveProviderName()` existe para el log de arranque y para que el panel
 * del demo pueda mostrar con que motor esta hablando.
 */

import { config } from '../config.js';
import type { AgentTurnRequest, LlmProvider } from '../types.js';
import { createBedrockProvider, type BedrockClientLike } from './bedrockProvider.js';
import { parsePromptSnapshot, type PromptSnapshot } from './systemPrompt.js';

export const SCRIPTED_PROVIDER_NAME = 'scripted';

// -----------------------------------------------------------------------------
// Proveedor de respaldo: determinista, sin red
// -----------------------------------------------------------------------------

/** Frases seguras para cuando no hay biometria legible en el prompt. */
const SAFE_REPLIES: readonly string[] = [
  'Estoy aquí contigo. Cuéntame qué estás sintiendo ahora mismo.',
  'Te escucho. No tienes que resolverlo solo, vamos paso a paso.',
  'Sigo contigo. Respira conmigo un momento y me cuentas cómo vas.',
];

/** Cuenta los turnos del paciente: define en que punto de la llamada estamos. */
function countPatientTurns(req: AgentTurnRequest): number {
  return req.messages.filter((message) => message.role === 'user').length;
}

function firstName(snapshot: PromptSnapshot): string | null {
  const name = snapshot.displayName;
  if (name === null || name.trim() === '') return null;
  return name.trim().split(' ')[0] ?? null;
}

/**
 * Arma la respuesta del proveedor de respaldo.
 *
 * Determinista: mismo prompt + mismo numero de turnos -> misma frase.
 * Funcion pura y exportada para poder testearla directamente.
 */
export function buildScriptedReply(req: AgentTurnRequest): string {
  const snapshot = parsePromptSnapshot(req.systemPrompt);
  const turn = countPatientTurns(req);
  const name = firstName(snapshot);
  const vocative = name === null ? '' : ` ${name}`;

  const hasVitals = snapshot.heartRate !== null && snapshot.heartRateBaseline !== null;

  if (!hasVitals) {
    return SAFE_REPLIES[Math.max(0, turn - 1) % SAFE_REPLIES.length] ?? SAFE_REPLIES[0]!;
  }

  const activity = snapshot.firstActivityTitle;
  const activityClause =
    activity === null
      ? 'Vamos a hacer juntos lo que dice tu plan de cuidado.'
      : `Tu plan de cuidado dice empezar con ${activity}.`;

  // El PRIMER turno siempre lleva los dos numeros: es lo que demuestra que hay
  // datos reales detras. Los turnos siguientes rotan sin repetir la misma frase.
  if (turn <= 1) {
    return [
      `Estoy contigo${vocative}.`,
      `Tu ritmo está en ${snapshot.heartRate}, y tu promedio de las últimas semanas es ${snapshot.heartRateBaseline}.`,
      activityClause,
      '¿Lo hacemos juntos?',
    ].join(' ');
  }

  const rotation = (turn - 2) % 3;
  if (rotation === 0) {
    return `Te escucho. Tu cuerpo está muy activado ahora mismo y eso se puede acompañar. ${activityClause} ¿Seguimos?`;
  }
  if (rotation === 1) {
    return `Sigo aquí${vocative}. No tiene que salir perfecto, solo parejo. Cuéntame cómo vas.`;
  }
  return `Estoy contigo. Tu ritmo estaba en ${snapshot.heartRate} y tu promedio es ${snapshot.heartRateBaseline}; vamos paso a paso. ¿Cómo lo sientes?`;
}

/**
 * Trocea el texto en frases para emitirlas como deltas.
 * El orquestador manda cada frase al TTS en cuanto la recibe, asi que el
 * respaldo se comporta igual que el streaming real.
 */
function splitIntoDeltas(text: string): string[] {
  const matches = text.match(/[^.?!]+[.?!]*\s*/g);
  if (matches === null || matches.length === 0) return [text];
  return matches.filter((chunk) => chunk.trim() !== '');
}

/**
 * Proveedor de respaldo. Sin red, sin credenciales, sin reloj.
 */
export function createScriptedProvider(): LlmProvider {
  return {
    name: SCRIPTED_PROVIDER_NAME,
    async *streamReply(req: AgentTurnRequest, signal?: AbortSignal): AsyncIterable<string> {
      const reply = buildScriptedReply(req);
      for (const chunk of splitIntoDeltas(reply)) {
        if (signal?.aborted === true) return;
        yield chunk;
      }
    },
  };
}

// -----------------------------------------------------------------------------
// Envoltura con degradacion
// -----------------------------------------------------------------------------

export interface FallbackHooks {
  /** Se llama cuando el proveedor primario falla y entra el respaldo. */
  onDegrade?: (providerName: string, error: Error) => void;
}

/**
 * Envuelve un proveedor primario con degradacion automatica al respaldo.
 *
 * Casos:
 *   - El primario lanza ANTES de emitir texto -> se loguea y responde el respaldo.
 *   - El primario termina sin emitir nada     -> responde el respaldo.
 *   - El primario lanza DESPUES de emitir     -> se corta ahi. No se puede
 *     retirar lo ya dicho, y encadenar dos respuestas distintas sonaria roto.
 *   - El turno fue abortado (`signal`)        -> silencio, no es un fallo: casi
 *     siempre significa que una red-flag corto el turno a proposito.
 */
export function withFallback(
  primary: LlmProvider,
  fallback: LlmProvider,
  hooks?: FallbackHooks,
): LlmProvider {
  return {
    name: primary.name,
    async *streamReply(req: AgentTurnRequest, signal?: AbortSignal): AsyncIterable<string> {
      let emitted = false;

      try {
        for await (const delta of primary.streamReply(req, signal)) {
          emitted = true;
          yield delta;
        }
      } catch (error) {
        if (signal?.aborted === true) return;

        const failure = error instanceof Error ? error : new Error(String(error));
        hooks?.onDegrade?.(fallback.name, failure);
        console.warn(`[agent] ${primary.name} falló (${failure.message}); usando ${fallback.name}`);

        if (emitted) return;
        yield* fallback.streamReply(req, signal);
        return;
      }

      if (emitted || signal?.aborted === true) return;

      const failure = new Error('el proveedor primario no emitió texto');
      hooks?.onDegrade?.(fallback.name, failure);
      console.warn(`[agent] ${primary.name} respondió vacío; usando ${fallback.name}`);
      yield* fallback.streamReply(req, signal);
    },
  };
}

// -----------------------------------------------------------------------------
// Seleccion
// -----------------------------------------------------------------------------

let activeProviderName: string = SCRIPTED_PROVIDER_NAME;
let cachedProvider: LlmProvider | null = null;

export interface SelectProviderDeps {
  /** Fabrica del cliente de Bedrock. Solo se usa en tests. */
  createClient?: () => BedrockClientLike;
  hooks?: FallbackHooks;
}

/**
 * Nucleo testeable de la seleccion: no toca `config`, recibe los valores.
 *
 * Sin `modelId` no se construye el cliente de Bedrock siquiera: el proveedor de
 * respaldo es el primario y el demo sigue de pie.
 */
export function selectProvider(
  modelId: string | undefined,
  region: string,
  deps?: SelectProviderDeps,
): LlmProvider {
  const scripted = createScriptedProvider();

  if (modelId === undefined || modelId.trim() === '') {
    return scripted;
  }

  const bedrock = createBedrockProvider({
    modelId,
    region,
    createClient: deps?.createClient,
  });

  return withFallback(bedrock, scripted, {
    onDegrade: (providerName, error) => {
      activeProviderName = providerName;
      deps?.hooks?.onDegrade?.(providerName, error);
    },
  });
}

/**
 * Proveedor del proceso. Se memoriza para no reconstruir el cliente de AWS en
 * cada turno (reconstruirlo por turno costaria handshake TLS = latencia).
 */
export function getLlmProvider(): LlmProvider {
  if (cachedProvider === null) {
    cachedProvider = selectProvider(config.aws.modelId, config.aws.region);
    activeProviderName = cachedProvider.name;
  }
  return cachedProvider;
}

/**
 * Nombre del proveedor que esta respondiendo de verdad ahora mismo.
 * Cambia a `scripted` en cuanto Bedrock degrada.
 */
export function getActiveProviderName(): string {
  return activeProviderName;
}

/** Solo para tests: olvida el proveedor memorizado. */
export function resetLlmProvider(): void {
  cachedProvider = null;
  activeProviderName = SCRIPTED_PROVIDER_NAME;
}
