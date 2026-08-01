/**
 * `turnPipeline` — lo que pasa con UN turno del paciente.
 *
 * Este es el archivo que hay que leer para entender loop-voice. Todo lo demas
 * (websockets, SSE, fixtures, TTS) es fontaneria alrededor de la funcion
 * `runPatientTurn` de mas abajo.
 */

import { checkCoverage as defaultCheckCoverage } from '../clients/coverageClient.js';
import { runIntervention } from '../agent/interventionGuide.js';
import { getLlmProvider } from '../agent/llm.js';
import { splitIntoSpeakableChunks } from '../audio/sentenceSplitter.js';
import { synthesize as defaultSynthesize } from '../audio/tts.js';
import { emitCoverageCheck, emitSafetyEscalation, emitTranscriptTurn } from '../live/bus.js';
import { describeError, log, preview } from '../logger.js';
import {
  COVERAGE_UNAVAILABLE_LINE,
  evaluate,
  inspectAgentChunk,
  normalize,
} from '../safety/index.js';
import type { CallSession } from '../session/callSession.js';
import type {
  AgentTurnRequest,
  CallState,
  CarePlanActivity,
  CoverageCheckRequest,
  CoverageCheckResponse,
  CoverageStatus,
  CurrentBiometrics,
  EpisodeOutcome,
  LlmProvider,
  PatientContext,
  RedFlagResult,
  TtsResult,
} from '../types.js';

// =============================================================================
// 1. La superficie de salida: hacia donde habla el agente
// =============================================================================

/**
 * Todo lo que el pipeline emite hacia el cliente (el navegador, por WebSocket).
 *
 * Se declara como interfaz y no se llama al socket directamente por dos
 * motivos: el test del pipeline puede grabar cada llamada sin levantar un
 * servidor, y `POST /api/v1/call/simulate` puede correr el MISMO pipeline con un
 * sumidero mudo. Un camino de codigo, dos entradas.
 *
 * Ninguna implementacion puede lanzar: `safeSink()` las envuelve.
 */
export interface CallSink {
  /** `text` es SIEMPRE el acumulado del turno, no un delta (protocolo 2.1). */
  transcript(speaker: 'patient' | 'agent', text: string, final: boolean): void;
  audio(result: TtsResult, seq: number): void;
  state(state: CallState): void;
  escalation(payload: {
    rule: string;
    action: string;
    script: string;
    evidence: string | null;
  }): void;
  coverage(payload: {
    status: CoverageStatus;
    voiceSummary: string;
    copayCents: number | null;
    payerName: string | null;
  }): void;
  biometrics(payload: { heartRate: number; hrv: number; respiratoryRate: number }): void;
  ready(payload: Record<string, unknown>): void;
  ended(payload: {
    outcome: EpisodeOutcome;
    encounterId: string | null;
    medplumUrl: string | null;
  }): void;
  error(message: string, fatal: boolean): void;
}

/** Sumidero mudo. Lo usan `/simulate`, el smoke y los tests. */
export const NOOP_SINK: CallSink = Object.freeze({
  transcript: () => undefined,
  audio: () => undefined,
  state: () => undefined,
  escalation: () => undefined,
  coverage: () => undefined,
  biometrics: () => undefined,
  ready: () => undefined,
  ended: () => undefined,
  error: () => undefined,
});

/**
 * Envuelve un sink para que ninguna de sus llamadas pueda tumbar la llamada.
 * Si el socket del navegador muere a mitad de un turno, el agente sigue
 * hablando, el episodio se sigue escribiendo y el dashboard sigue recibiendo.
 */
export function safeSink(sink: CallSink): CallSink {
  const guard =
    <A extends unknown[]>(name: string, fn: (...args: A) => void) =>
    (...args: A): void => {
      try {
        fn(...args);
      } catch (err) {
        log.warn('sink.error', { method: name, message: describeError(err) });
      }
    };

  return {
    transcript: guard('transcript', sink.transcript.bind(sink)),
    audio: guard('audio', sink.audio.bind(sink)),
    state: guard('state', sink.state.bind(sink)),
    escalation: guard('escalation', sink.escalation.bind(sink)),
    coverage: guard('coverage', sink.coverage.bind(sink)),
    biometrics: guard('biometrics', sink.biometrics.bind(sink)),
    ready: guard('ready', sink.ready.bind(sink)),
    ended: guard('ended', sink.ended.bind(sink)),
    error: guard('error', sink.error.bind(sink)),
  };
}

// =============================================================================
// 2. El estado de una llamada viva
// =============================================================================

/** Lo que el pipeline necesita poder hacer con el ciclo de vida de la llamada. */
export interface CallHooks {
  /** Cierra la llamada: infiere outcome, escribe el episodio, avisa a todos. */
  endCall(outcome: EpisodeOutcome | null, reason: string): Promise<void>;
}

/**
 * Una llamada en curso. La construye `callOrchestrator.startCall`.
 *
 * `biometrics` es la lectura VIVA (la actualizan los ticks), no la foto del
 * contexto: el motor de red-flags tiene que evaluar RF-08 contra lo que el
 * reloj esta marcando ahora, no contra lo que marcaba al descolgar.
 */
export interface ActiveCall {
  readonly callId: string;
  readonly patientId: string;
  readonly session: CallSession;
  readonly ctx: PatientContext;
  readonly systemPrompt: string;
  readonly sink: CallSink;
  readonly hooks: CallHooks;
  readonly deps: Partial<PipelineDeps>;

  /** Historial que se manda al LLM. No incluye las frases puente. */
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  biometrics: CurrentBiometrics;

  /** Aborta la generacion del LLM en curso. Lo dispara una red-flag. */
  llmAbort: AbortController | null;
  /** Corta la guia de intervencion en curso. */
  interventionStop: { aborted: boolean } | null;

  audioSeq: number;
  /** Actividad propuesta y esperando un "si". */
  pendingActivityId: string | null;
  /** Actividad terminada, esperando el alivio 0-10. */
  awaitingRelief: string | null;
  /** Esperando la severidad auto-reportada 0-10. */
  awaitingSeverity: boolean;
  /** `serviceType` ya verificados: no se pregunta dos veces por lo mismo. */
  coverageDone: Set<string>;
  /**
   * El ultimo `voiceSummary` que devolvio :3003, LITERAL.
   *
   * Se guarda para poder repetirlo si el paciente vuelve a preguntar por el
   * costo. Sin esto, la segunda pregunta caia en la linea de "no pude
   * verificarlo" y el agente se contradecia con lo que acababa de decir. Se
   * repite el texto de Carlos tal cual, nunca una parafrasis nuestra ni del
   * modelo: la regla del Contrato 3 vale igual la segunda vez.
   */
  lastCoverageSummary: string | null;
  /** Intervenciones ya corridas: no se repite la respiracion en bucle. */
  interventionsRun: Set<string>;
  ended: boolean;
}

// =============================================================================
// 3. Dependencias inyectables
// =============================================================================

export interface PipelineDeps {
  llm: LlmProvider;
  synthesize: (text: string) => Promise<TtsResult>;
  checkCoverage: (req: CoverageCheckRequest) => Promise<CoverageCheckResponse>;
  /** Divide las pausas de la intervencion. 1 = tiempo real, 200 = tests. */
  speedFactor: number;
  /** Si el LLM no emite su primer delta antes de esto, entra la frase puente. */
  bridgeMs: number;
}

/**
 * Umbral de la frase puente.
 *
 * El objetivo del brief es <800ms de fin-de-habla a inicio-de-respuesta. Si a
 * los 600ms Bedrock todavia no ha emitido nada, ya no llegamos: se locuta una
 * frase corta y honesta mientras el modelo termina de pensar. No es decoracion,
 * es lo que impide que alguien en panico escuche dos segundos de silencio.
 */
export const DEFAULT_BRIDGE_MS = 600;

/**
 * Frase puente. Fija, corta y pre-sintetizada al arrancar el servidor (entra en
 * la cache LRU del TTS), asi que cuando hace falta suena instantanea.
 */
export const BRIDGE_LINE = 'Dame un segundo, estoy mirando tus datos.';

/** Lo que se locuta despues del alivio, para cerrar el bucle de la severidad. */
export const SEVERITY_QUESTION =
  'Gracias. Y en lo más fuerte, del cero al diez, ¿qué tan intenso llegó a sentirse?';

function defaultSpeedFactor(): number {
  // Ensayos: `INTERVENTION_SPEED=10 npm -w voice start` recorta las pausas de
  // la respiracion sin tocar codigo. En el escenario va a 1 (tiempo real).
  const raw = Number(process.env.INTERVENTION_SPEED);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

let moduleOverrides: Partial<PipelineDeps> = {};

/**
 * Sustituye dependencias para TODO el proceso.
 *
 * Existe para el smoke (`scripts/smoke.ts`), que inyecta un `LlmProvider` espia
 * para demostrar con un contador que el modelo no se invoca cuando dispara una
 * regla. En produccion nadie llama a esto.
 */
export function overridePipelineDeps(partial: Partial<PipelineDeps>): void {
  moduleOverrides = { ...moduleOverrides, ...partial };
}

/** Deshace `overridePipelineDeps`. */
export function resetPipelineDeps(): void {
  moduleOverrides = {};
}

function resolveDeps(call: ActiveCall, extra: Partial<PipelineDeps> = {}): PipelineDeps {
  const merged = { ...moduleOverrides, ...call.deps, ...extra };
  return {
    // `getLlmProvider()` se resuelve aqui y no al importar: el proveedor se
    // memoriza en su propio modulo y los tests lo resetean.
    llm: merged.llm ?? getLlmProvider(),
    synthesize: merged.synthesize ?? defaultSynthesize,
    checkCoverage: merged.checkCoverage ?? defaultCheckCoverage,
    speedFactor: merged.speedFactor ?? defaultSpeedFactor(),
    bridgeMs: merged.bridgeMs ?? DEFAULT_BRIDGE_MS,
  };
}

/** Deps resueltas sin una llamada de por medio (saludo, pre-calentado). */
export function resolveStandaloneDeps(extra: Partial<PipelineDeps> = {}): PipelineDeps {
  const merged = { ...moduleOverrides, ...extra };
  return {
    llm: merged.llm ?? getLlmProvider(),
    synthesize: merged.synthesize ?? defaultSynthesize,
    checkCoverage: merged.checkCoverage ?? defaultCheckCoverage,
    speedFactor: merged.speedFactor ?? defaultSpeedFactor(),
    bridgeMs: merged.bridgeMs ?? DEFAULT_BRIDGE_MS,
  };
}

// =============================================================================
// 4. Deteccion por palabras clave (NUNCA por LLM)
// =============================================================================
//
// Las tres detecciones de abajo deciden por que rama va el turno. Se hacen con
// keywords sobre el texto normalizado, igual que el motor de red-flags, y por la
// misma razon: si el modelo decidiera cuando disparar un coverage check o cuando
// empezar la respiracion, no podriamos garantizar nada sobre esos caminos. Un
// falso negativo aqui cuesta una frase de conversacion; delegarlo cuesta el
// control del producto.

/**
 * Pregunta por dinero: costo, cobertura, seguro, copago. ES + EN.
 *
 * CUIDADO CON EL VERBO "COSTAR". La primera version de este detector incluia
 * `\bcuesta\b` suelto y rompia el producto: *"me cuesta respirar"* y
 * *"me cuesta dormir"* — dos de las frases mas frecuentes de una llamada de
 * panico — se iban a verificar cobertura en vez de a la conversacion. Por eso
 * las formas de "costar" solo cuentan acompañadas de "cuanto", y `cara` esta
 * excluido a proposito (`se me durmio la cara` no es una pregunta de precio).
 */
const COVERAGE_PATTERNS: readonly RegExp[] = [
  /\b(copago|copagos|copay|deducible|deductible|cobertura|coverage|aseguradora|insurance)\b/,
  /\b(mi|el|la|su|tu) seguro\b/,
  /\bseguro (medico|de salud)\b/,
  /\b(cubre|cubren|covered)\b/,
  /\bcuanto\b[^|]{0,25}\b(cuesta|cuestan|vale|valen|sale|salen|costar|costaria|cobran|pagar|pago)\b/,
  /\b(precio|tarifa|how much|out of pocket)\b/,
  /\bcaro\b/,
];

/** Acepta la propuesta del agente. */
const ACCEPT_RE =
  /\b(si|sii+|claro|vale|bueno|ok|okay|oka|dale|va|listo|hagamoslo|hagamos|hagamoslo juntos|empecemos|empieza|adelante|por favor|intentemos|probemos|yes|sure|lets do it|okey)\b/;

/** Pide expresamente la intervencion. */
const REQUEST_INTERVENTION_RE =
  /\b(respir\w*|ejercicio|el ejercicio|la tecnica|tecnica|grounding|anclaje|guiame|guiar|ayudame a respirar|breathing|breathe)\b/;

/** Pide parar. Corta la intervencion en curso. */
const STOP_RE =
  /\b(para|parar|basta|stop|detente|ya no|no puedo mas|no quiero|espera|esperate|dejame|callate)\b/;

/** Detecta una peticion de cobertura/costo en un turno del paciente. */
export function asksAboutCoverage(text: string): boolean {
  const normalized = normalize(text);
  return COVERAGE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * ¿La respuesta del agente propone la intervencion?
 *
 * Es lo que "arma" el `si` del turno siguiente. Se mira la salida del modelo con
 * keywords, no se le pregunta al modelo si propuso algo: un turno mas de LLM
 * para averiguar lo que ya tenemos escrito delante seria latencia regalada.
 */
export function proposesIntervention(agentText: string, activity: CarePlanActivity): boolean {
  const normalized = normalize(agentText);
  if (normalized === '') return false;
  if (/\brespir\w*/.test(normalized)) return true;
  const title = normalize(activity.title);
  return title !== '' && normalized.includes(title);
}

/** Detecta un "si" a la propuesta de intervencion. */
export function acceptsIntervention(text: string): boolean {
  const normalized = normalize(text);
  return ACCEPT_RE.test(normalized) || REQUEST_INTERVENTION_RE.test(normalized);
}

/** Detecta una peticion de parar. */
export function asksToStop(text: string): boolean {
  return STOP_RE.test(normalize(text));
}

/**
 * Extrae un numero del 0 al 10 de una respuesta hablada.
 *
 * Acepta digitos sueltos y las palabras (`cero`..`diez`). Deliberadamente NO
 * acepta numeros de tres cifras: el paciente puede estar repitiendo su
 * frecuencia cardiaca ("estoy en 118") y eso no es una puntuacion de alivio.
 * Devuelve null si no hay nada claro; entonces el turno sigue al LLM y el
 * campo se queda vacio en el episodio, que es la respuesta honesta.
 */
export function parseZeroToTen(text: string): number | null {
  const normalized = normalize(text);

  const digits = normalized.match(/(?<![\d.,])(10|[0-9])(?![\d.,])/);
  if (digits !== null) return Number(digits[1]);

  const words: Record<string, number> = {
    cero: 0,
    uno: 1,
    una: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
    seis: 6,
    siete: 7,
    ocho: 8,
    nueve: 9,
    diez: 10,
  };
  for (const [word, value] of Object.entries(words)) {
    if (new RegExp(`\\b${word}\\b`).test(normalized)) return value;
  }
  return null;
}

// =============================================================================
// 5. Locucion
// =============================================================================

function setState(call: ActiveCall, state: CallState): void {
  call.session.setState(state);
  call.sink.state(state);
}

/**
 * Cola de locucion.
 *
 * =============================================================================
 *  SINTESIS EN PARALELO, ENVIO EN ORDEN
 * =============================================================================
 * `push()` arranca el TTS de esa frase INMEDIATAMENTE, pero encadena su envio
 * detras de lo que ya habia. Asi el audio le llega al navegador en el orden en
 * que se dijo, sin que cada frase tenga que esperar a que la anterior se haya
 * sintetizado.
 *
 * No es una optimizacion cosmetica. Medido contra Deepgram Aura-2 real: una
 * frase de 41 caracteres tarda ~2s y el guion completo del 911 (318 caracteres)
 * se pasa del presupuesto de 4s, cae a Polly y tarda **ocho segundos**. Ocho
 * segundos de silencio despues de detectar un posible infarto. Troceado por
 * frases, cada peticion vuelve dentro del presupuesto, la primera suena en un
 * par de segundos y el resto encadena sin huecos.
 *
 * `signal` permite que una red-flag cancele lo que aun no ha sonado. Lo que ya
 * salio por el altavoz no se puede retirar; lo que no, no suena.
 */
interface SpeechQueue {
  push(text: string): void;
  drain(): Promise<void>;
  firstAudioMs(): number | null;
}

function createSpeechQueue(
  call: ActiveCall,
  deps: PipelineDeps,
  opts: { startedAt: number; signal?: AbortSignal },
): SpeechQueue {
  let chain: Promise<void> = Promise.resolve();
  let first: number | null = null;

  const cancelled = (): boolean => opts.signal?.aborted === true || call.ended;

  return {
    push(text: string): void {
      const clean = text.trim();
      if (clean === '') return;

      const job = deps.synthesize(clean);
      // El rechazo se maneja dentro de la cadena; este handler solo evita un
      // `unhandledRejection` si el envio nunca llega a consumir la promesa.
      job.catch(() => undefined);

      chain = chain.then(async () => {
        if (cancelled()) return;
        try {
          const audio: TtsResult = await job;
          if (cancelled()) return;
          call.sink.audio(audio, call.audioSeq++);
          if (first === null) first = Date.now() - opts.startedAt;
        } catch (err) {
          // `synthesize` promete no lanzar; esto cubre un TTS inyectado.
          log.error('tts.failed', { callId: call.callId, message: describeError(err) });
        }
      });
    },

    drain(): Promise<void> {
      return chain;
    },

    firstAudioMs(): number | null {
      return first;
    },
  };
}

/** Envuelve una cadena en un stream de un solo elemento, para poder trocearla. */
async function* single(text: string): AsyncIterable<string> {
  yield text;
}

/**
 * Trocea un texto fijo igual que se trocea la salida del modelo.
 *
 * Lo usa el pre-calentado del TTS al arrancar el servidor: la clave de la cache
 * es el texto exacto que se pide, asi que calentar el guion ENTERO no serviria
 * de nada si luego se piden sus frases una a una. Tienen que ser los mismos
 * fragmentos o la cache no se toca.
 */
export async function toSpeakableChunks(text: string): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of splitIntoSpeakableChunks(single(text))) chunks.push(chunk);
  return chunks;
}

/**
 * Locuta un texto FIJO (guion de escalacion, saludo, care plan, voiceSummary) y
 * lo registra como turno del agente.
 *
 * El texto se registra ENTERO en el transcript (es una sola cosa que se dijo)
 * pero se sintetiza POR FRASES, por lo explicado en `createSpeechQueue`.
 *
 * `intoSession: false` para los rellenos de latencia: el paciente los oye, pero
 * no aportan nada al contexto del modelo ni al episodio clinico.
 */
export async function speakFixedLine(
  call: ActiveCall,
  text: string,
  deps: PipelineDeps,
  opts: { intoHistory?: boolean; intoSession?: boolean } = {},
): Promise<void> {
  const clean = text.trim();
  if (clean === '') return;

  const intoSession = opts.intoSession ?? true;
  const intoHistory = opts.intoHistory ?? true;

  if (intoSession) call.session.addTurn('agent', clean);
  if (intoHistory) call.history.push({ role: 'assistant', text: clean });
  if (intoSession) emitTranscriptTurn({ callId: call.callId, speaker: 'agent', text: clean });
  call.sink.transcript('agent', clean, true);

  const queue = createSpeechQueue(call, deps, { startedAt: Date.now() });
  for await (const chunk of splitIntoSpeakableChunks(single(clean))) {
    queue.push(chunk);
  }
  await queue.drain();
}

// =============================================================================
// 6. Resultado de un turno
// =============================================================================

export type TurnPath =
  | 'escalation'
  | 'coverage'
  | 'intervention'
  | 'relief'
  | 'llm'
  | 'ignored';

export interface TurnResult {
  path: TurnPath;
  escalated: boolean;
  ruleId: string | null;
  action: string | null;
  evidence: string | null;
  /** La prueba del algodon: false en TODO camino de escalacion. */
  llmInvoked: boolean;
  agentText: string;
  /** ms desde el turno cerrado del paciente hasta el primer audio enviado. */
  firstAudioMs: number | null;
  totalMs: number;
}

function result(partial: Partial<TurnResult> & { path: TurnPath; totalMs: number }): TurnResult {
  return {
    escalated: false,
    ruleId: null,
    action: null,
    evidence: null,
    llmInvoked: false,
    agentText: '',
    firstAudioMs: null,
    ...partial,
  };
}

// =============================================================================
// 7. runPatientTurn — EL ORDEN QUE NO SE NEGOCIA
// =============================================================================

/**
 * =============================================================================
 *  POR QUE ESTE ORDEN Y NO OTRO
 * =============================================================================
 *
 * El turno del paciente pasa por estos pasos, SIEMPRE, en este orden:
 *
 *   1. Se registra el turno (sesion + transcript + SSE).
 *   2. Se aborta cualquier generacion del LLM que estuviera en vuelo.
 *   3. `evaluate()` — el motor de red-flags. Determinista, puro, sin red.
 *   4. Si disparo: guion HARDCODEADO, escalacion, fin de la llamada.
 *      Si no disparo: recien ahi puede hablar el modelo.
 *
 * Las razones, una por una:
 *
 * · **El paso 3 va antes del 4 porque la seguridad no puede depender de que un
 *   modelo coopere.** Si la evaluacion viviera en el prompt del sistema, seria
 *   una peticion: "por favor, si detectas dolor toracico irradiado, escala".
 *   Aqui es un `if`. Un juez puede leer `safety/rules.ts`, correr
 *   `npm run redflag "..."` en su propia terminal y obtener exactamente el mismo
 *   veredicto que obtiene la llamada en vivo, sin credenciales y sin red. Eso no
 *   se puede afirmar de nada que pase por un LLM.
 *
 * · **El paso 2 va antes del 3 y no despues del 4.** Si el paciente dijo algo
 *   benigno, el agente empezo a responder, y en el turno siguiente dice
 *   "me duele el pecho y se me va al brazo", la generacion anterior TIENE que
 *   morir antes de que salga una sola frase mas por el altavoz. Nadie puede oir
 *   al agente terminando una frase amable por encima de una instruccion de
 *   llamar al 911. El `AbortSignal` es lo que lo garantiza, y la cola de audio
 *   comprueba `aborted` justo antes de escribir cada fragmento.
 *
 * · **El paso 1 va primero, antes incluso de la evaluacion.** El turno se
 *   registra pase lo que pase. Si el proceso muriera entre el paso 1 y el 4, el
 *   episodio seguiria conteniendo lo que el paciente dijo. Un transcript
 *   incompleto es un problema; un transcript que se pierde entero porque la
 *   escalacion fallo, es otro mucho peor.
 *
 * · **El modo texto (`{"type":"text"}`) entra por esta misma funcion.** No hay
 *   un atajo para el respaldo por teclado. Si lo hubiera, existiria un camino de
 *   entrada al agente que no pasa por el motor de seguridad, y ese camino seria
 *   el que se usa justo cuando algo ya ha salido mal en el escenario.
 *
 * · **`filterAgentOutput` corre sobre CADA fragmento antes de sintetizarlo**, no
 *   sobre la respuesta completa al final. El TTS locuta por frases para bajar la
 *   latencia; filtrar al final significaria filtrar cuando la primera frase ya
 *   sono. El filtro es la contraparte de salida del motor de entrada: uno vigila
 *   lo que el paciente dice, el otro lo que el modelo contesta, y ninguno de los
 *   dos le pregunta a un modelo.
 *
 * =============================================================================
 */
export async function runPatientTurn(
  call: ActiveCall,
  text: string,
  extraDeps: Partial<PipelineDeps> = {},
): Promise<TurnResult> {
  const deps = resolveDeps(call, extraDeps);
  const startedAt = Date.now();
  const clean = typeof text === 'string' ? text.trim() : '';

  if (clean === '' || call.ended) {
    return result({ path: 'ignored', totalMs: Date.now() - startedAt });
  }

  // --- 1. El turno se registra ANTES de cualquier decision --------------------
  call.session.addTurn('patient', clean);
  call.history.push({ role: 'user', text: clean });
  emitTranscriptTurn({ callId: call.callId, speaker: 'patient', text: clean });
  call.sink.transcript('patient', clean, true);
  log.info('turn.patient', { callId: call.callId, ...preview(clean) });

  // --- 2. Se mata lo que el modelo estuviera diciendo -------------------------
  abortLlm(call);

  // --- 3. MOTOR DE RED-FLAGS. Determinista. Sin LLM. --------------------------
  const verdict = evaluate({
    transcriptText: clean,
    biometrics: call.biometrics,
    safetyEnvelope: call.ctx.safetyEnvelope,
  });

  log.info('redflag.evaluated', {
    callId: call.callId,
    triggered: verdict.triggered,
    rule: verdict.ruleId,
    severity: verdict.severity,
    evidence: verdict.matchedEvidence,
  });

  // --- 3b. La llamada YA escalo: estado terminal ------------------------------
  //
  // ==========================================================================
  //  LA ESCALACION NO ES UN TURNO, ES UN ESTADO TERMINAL
  // ==========================================================================
  // `escalate()` marca la sesion como `escalated` de forma sincrona, pero
  // despues se queda locutando el guion del 911, que dura entre dos y ocho
  // segundos (ver `createSpeechQueue`). `call.ended` no se pone a true hasta el
  // final de esa ventana.
  //
  // Durante esos segundos el paciente sigue hablando —"pero es que estoy muy
  // nervioso", "¿en serio?"— y el socket sigue entregando turnos. Sin esta
  // guarda, ese turno se evalua, no dispara ninguna regla (es una frase
  // benigna), y sigue hasta el LLM: el modelo contesta y el TTS lo locuta POR
  // ENCIMA de la instruccion de colgar y llamar al 911. Reproducido con un TTS
  // de 2s y un turno inyectado a los 300ms.
  //
  // Que el modelo no vea el turno que DISPARO la regla no basta. Tampoco puede
  // ver ninguno de los que vengan detras. La regla del brief es que la llamada
  // TERMINA en la escalacion, y esto es lo que lo hace cierto.
  //
  // El turno del paciente ya quedo registrado arriba (paso 1) y la evaluacion ya
  // quedo logueada: la auditoria no pierde nada, solo se corta la salida.
  if (call.session.getState() === 'escalated') {
    log.warn('turn.after-escalation', {
      callId: call.callId,
      triggered: verdict.triggered,
      rule: verdict.ruleId,
      llmInvoked: false,
      note: 'la llamada ya escalo: el turno no va al modelo ni al TTS',
    });
    return result({ path: 'ignored', totalMs: Date.now() - startedAt });
  }

  // --- 4a. Disparo: el modelo NO ve este turno --------------------------------
  if (verdict.triggered) {
    await escalate(call, verdict, deps);
    return result({
      path: 'escalation',
      escalated: true,
      ruleId: verdict.ruleId,
      action: verdict.action,
      evidence: verdict.matchedEvidence,
      llmInvoked: false,
      agentText: verdict.script ?? '',
      totalMs: Date.now() - startedAt,
    });
  }

  // --- 4b. Sin disparo: el resto de caminos ----------------------------------

  // Intervencion en curso: el paciente hablo mientras respiraba. La red-flag ya
  // se evaluo arriba (por eso este bloque va DESPUES). Si solo esta comentando,
  // no se le interrumpe con una respuesta del modelo; si pide parar, se corta.
  if (call.interventionStop !== null && !call.interventionStop.aborted) {
    if (asksToStop(clean)) {
      log.info('intervention.stopped', { callId: call.callId, reason: 'peticion del paciente' });
      call.interventionStop.aborted = true;
    } else {
      log.debug('turn.during-intervention', { callId: call.callId });
      return result({ path: 'ignored', totalMs: Date.now() - startedAt });
    }
  }

  // Captura de alivio (0-10) tras una intervencion.
  if (call.awaitingRelief !== null) {
    const relief = parseZeroToTen(clean);
    if (relief !== null) {
      const activityId = call.awaitingRelief;
      call.awaitingRelief = null;
      call.session.recordIntervention(activityId, true, relief);
      log.info('intervention.relief', { callId: call.callId, activityId, relief });

      await speakFixedLine(call, SEVERITY_QUESTION, deps);
      call.awaitingSeverity = true;
      setState(call, 'listening');
      return result({
        path: 'relief',
        agentText: SEVERITY_QUESTION,
        totalMs: Date.now() - startedAt,
      });
    }
    // No dijo un numero: se deja la pregunta abierta y sigue la conversacion.
    call.awaitingRelief = null;
  }

  // Captura de severidad auto-reportada (0-10).
  if (call.awaitingSeverity) {
    const severity = parseZeroToTen(clean);
    call.awaitingSeverity = false;
    if (severity !== null) {
      call.session.setSeverity(severity);
      log.info('severity.recorded', { callId: call.callId, severity });
      // Tras la severidad viene el momento natural del coverage check: el plan
      // dice "escribe a tu equipo" y eso tiene un precio.
      const coverage = await maybeRunCoverage(call, deps, 'despues-de-la-intervencion');
      if (coverage !== null) return coverage;
    }
  }

  // Pregunta por dinero.
  if (asksAboutCoverage(clean)) {
    const coverage = await maybeRunCoverage(call, deps, 'pregunta del paciente');
    if (coverage !== null) return coverage;

    // Sin actividad pendiente que verificar hay dos casos distintos, y decir lo
    // mismo en los dos era un fallo: si ya verificamos, se REPITE el
    // `voiceSummary` de :3003 literal; solo si nunca hubo nada que verificar se
    // dice que no se pudo. Antes, preguntar dos veces por el copago hacia que
    // el agente se desdijera de la cifra que acababa de dar.
    const line = call.lastCoverageSummary ?? COVERAGE_UNAVAILABLE_LINE;
    await speakFixedLine(call, line, deps);
    setState(call, 'listening');
    return result({ path: 'coverage', agentText: line, totalMs: Date.now() - startedAt });
  }

  // Acepta (o pide) la intervencion del care plan.
  const activity = pickIntervention(call, clean);
  if (activity !== null) {
    const spoken = await runInterventionFlow(call, activity, deps);
    return result({
      path: 'intervention',
      agentText: spoken,
      totalMs: Date.now() - startedAt,
    });
  }

  // --- 4c. Conversacion: aqui, y solo aqui, habla el modelo ------------------
  return runLlmTurn(call, deps, startedAt);
}

// =============================================================================
// 8. Escalacion
// =============================================================================

function abortLlm(call: ActiveCall): void {
  if (call.llmAbort !== null && !call.llmAbort.signal.aborted) {
    call.llmAbort.abort();
    log.debug('llm.aborted', { callId: call.callId });
  }
  call.llmAbort = null;
}

function abortIntervention(call: ActiveCall): void {
  if (call.interventionStop !== null) call.interventionStop.aborted = true;
}

/**
 * El camino de escalacion.
 *
 * El orden interno tambien importa: primero se corta todo lo que estuviera
 * sonando, luego se marca la sesion, luego se avisa al dashboard y al navegador
 * (el banner rojo tiene que aparecer YA, sin esperar al TTS), y solo despues se
 * locuta el guion. Si el TTS estuviera caido, la escalacion visual ya ocurrio.
 *
 * El texto que se locuta sale de `safety/scripts.ts`. No pasa por el modelo, no
 * pasa por `filterAgentOutput` (filtrar un guion de emergencia solo podria
 * empeorarlo) y no se parametriza.
 */
async function escalate(call: ActiveCall, verdict: RedFlagResult, deps: PipelineDeps): Promise<void> {
  abortLlm(call);
  abortIntervention(call);

  const rule = verdict.ruleId ?? 'RF-SIN-ID';
  const action = verdict.action ?? 'advise-911';
  const script = verdict.script ?? '';

  call.session.setEscalation(rule, action);
  call.sink.state('escalated');

  emitSafetyEscalation({ callId: call.callId, rule, action });
  call.sink.escalation({ rule, action, script, evidence: verdict.matchedEvidence });

  log.warn('safety.escalation', {
    callId: call.callId,
    rule,
    action,
    severity: verdict.severity,
    evidence: verdict.matchedEvidence,
    llmInvoked: false,
  });

  await speakFixedLine(call, script, deps);

  const outcome: EpisodeOutcome =
    action === 'advise-911' ? 'escalated-emergency' : 'escalated-human';

  await call.hooks.endCall(outcome, `red-flag ${rule}`);
}

// =============================================================================
// 9. Coverage — el `voiceSummary` se locuta LITERAL
// =============================================================================

function findCostActivity(call: ActiveCall): CarePlanActivity | null {
  const activities = [...call.ctx.carePlan.activities].sort((a, b) => a.order - b.order);
  for (const activity of activities) {
    const cost = activity.costItem;
    if (cost !== undefined && !call.coverageDone.has(cost.serviceType)) return activity;
  }
  return null;
}

/**
 * Verifica cobertura y locuta el resultado.
 *
 * =============================================================================
 *  POR QUE `voiceSummary` SE LOCUTA PALABRA POR PALABRA
 * =============================================================================
 * El campo lo redacta loop-coverage (:3003) a partir de un 271 real de Stedi.
 * Es la unica frase de toda la llamada que contiene una cifra de dinero del
 * paciente. Si pasara por el modelo pasarian dos cosas malas: se sumarian entre
 * 1 y 3 segundos de latencia a un momento en el que el paciente ya esta
 * esperando, y existiria una probabilidad distinta de cero de que "veinticinco
 * dolares" saliera por el altavoz como "veintiocho". Redondear el copago de
 * alguien es un fallo del que no se vuelve.
 *
 * Tampoco pasa por `filterAgentOutput`: ese filtro no corrige, SUSTITUYE la
 * frase entera por la linea segura. Aplicarlo aqui solo podria conseguir que un
 * dato de cobertura correcto desapareciera. El filtro existe para la salida
 * generada; esto no es salida generada.
 *
 * Y si :3003 no contesta, `checkCoverage` ya devuelve un `voiceSummary` honesto
 * ("no pude verificarlo, tu equipo te lo confirma"). Nunca se inventa un numero.
 *
 * Devuelve null si el care plan no tiene ninguna actividad con `costItem`.
 */
async function maybeRunCoverage(
  call: ActiveCall,
  deps: PipelineDeps,
  reason: string,
): Promise<TurnResult | null> {
  const startedAt = Date.now();
  const activity = findCostActivity(call);
  if (activity === null || activity.costItem === undefined) return null;

  const cost = activity.costItem;
  call.coverageDone.add(cost.serviceType);
  setState(call, 'coverage');
  log.info('coverage.requested', {
    callId: call.callId,
    serviceType: cost.serviceType,
    cptCode: cost.cptCode,
    reason,
  });

  const request: CoverageCheckRequest = {
    patientId: call.patientId,
    serviceType: cost.serviceType,
    cptCode: cost.cptCode,
    requestedBy: 'voice-agent',
    callId: call.callId,
  };

  // `checkCoverage` promete no lanzar; el try es por si se inyecta otro cliente.
  let check: CoverageCheckResponse;
  try {
    check = await deps.checkCoverage(request);
  } catch (err) {
    log.error('coverage.failed', { callId: call.callId, message: describeError(err) });
    await speakFixedLine(call, COVERAGE_UNAVAILABLE_LINE, deps);
    setState(call, 'listening');
    return result({
      path: 'coverage',
      agentText: COVERAGE_UNAVAILABLE_LINE,
      totalMs: Date.now() - startedAt,
    });
  }

  call.session.recordCoverage(check, cost.serviceType);
  emitCoverageCheck({
    callId: call.callId,
    checkId: check.checkId,
    status: check.status,
    copayCents: check.copayCents,
  });
  call.sink.coverage({
    status: check.status,
    voiceSummary: check.voiceSummary,
    copayCents: check.copayCents,
    payerName: check.payerName,
  });

  log.info('coverage.checked', {
    callId: call.callId,
    status: check.status,
    copayCents: check.copayCents,
    latencyMs: check.latencyMs,
  });

  // Preambulo fijo + resumen LITERAL del servicio de cobertura.
  const preamble = `Tu plan también dice: ${activity.title}.`;
  call.lastCoverageSummary = check.voiceSummary;
  await speakFixedLine(call, preamble, deps);
  await speakFixedLine(call, check.voiceSummary, deps);

  setState(call, 'listening');
  return result({
    path: 'coverage',
    agentText: `${preamble} ${check.voiceSummary}`,
    totalMs: Date.now() - startedAt,
  });
}

// =============================================================================
// 10. Intervencion guiada
// =============================================================================

function findActivity(call: ActiveCall, activityId: string | null): CarePlanActivity | null {
  if (activityId === null) return null;
  return call.ctx.carePlan.activities.find((a) => a.id === activityId) ?? null;
}

/** Siguiente actividad guiada del care plan que aun no se ha corrido. */
export function nextGuidedActivity(call: ActiveCall): CarePlanActivity | null {
  return (
    [...call.ctx.carePlan.activities]
      .sort((a, b) => a.order - b.order)
      .find(
        (activity) =>
          (activity.type === 'breathing' || activity.type === 'grounding') &&
          !call.interventionsRun.has(activity.id),
      ) ?? null
  );
}

/**
 * Decide si este turno arranca una intervencion del care plan.
 *
 * Dos entradas: el paciente acepta lo que el agente ACABA de proponer
 * (`pendingActivityId`, que se re-arma al final de cada turno del agente segun
 * lo que el agente dijo de verdad), o lo pide de motu propio ("hagamos la
 * respiracion"). La distincion importa porque en español "si" es tambien la
 * conjuncion condicional: *"si me pongo asi me da miedo"* no puede arrancar una
 * respiracion de caja de ochenta segundos. Solo cuenta como aceptacion cuando
 * hay una pregunta abierta encima de la mesa.
 *
 * Una actividad ya corrida no se repite: el objetivo es acompañar, no meter al
 * paciente en un bucle.
 */
function pickIntervention(call: ActiveCall, text: string): CarePlanActivity | null {
  if (!acceptsIntervention(text)) return null;

  const pending = findActivity(call, call.pendingActivityId);
  if (pending !== null && !call.interventionsRun.has(pending.id)) return pending;

  // Sin propuesta abierta hace falta que el paciente nombre la tecnica.
  if (!REQUEST_INTERVENTION_RE.test(normalize(text))) return null;
  return nextGuidedActivity(call);
}

/**
 * Locuta la actividad con su timing real (4 segundos de verdad por fase).
 *
 * El motor de red-flags SIGUE VIVO durante todo esto: cada turno del paciente
 * entra por `runPatientTurn`, se evalua igual, y si dispara, `escalate()` pone
 * `interventionStop.aborted = true`. El bucle lo comprueba antes de locutar cada
 * paso, asi que la respiracion se calla en el paso siguiente como maximo y la
 * escalacion no espera a que termine el ciclo.
 *
 * Los textos de los pasos NO pasan por `filterAgentOutput`: son el guion que
 * escribio el clinico (`voiceScript` del care plan) o las fases canonicas del
 * 4-4-4-4. Filtrar la voz del clinico seria sustituirla por la nuestra.
 */
async function runInterventionFlow(
  call: ActiveCall,
  activity: CarePlanActivity,
  deps: PipelineDeps,
): Promise<string> {
  abortLlm(call);
  call.pendingActivityId = null;
  call.interventionsRun.add(activity.id);

  const stop = { aborted: false };
  call.interventionStop = stop;

  setState(call, 'intervention');
  call.session.recordIntervention(activity.id, false, null);
  log.info('intervention.started', {
    callId: call.callId,
    activityId: activity.id,
    type: activity.type,
    speedFactor: deps.speedFactor,
  });

  const spoken: string[] = [];
  try {
    for await (const step of runIntervention(activity, { speedFactor: deps.speedFactor })) {
      if (stop.aborted || call.ended || call.session.getState() === 'escalated') break;
      spoken.push(step.text);
      // `intoHistory: false`: los 22 pasos del 4-4-4-4 no aportan nada al
      // contexto del modelo, y meterlos consumiria el prompt entero. Al final
      // del bucle se le deja un resumen de una linea.
      await speakFixedLine(call, step.text, deps, { intoHistory: false });
    }
  } catch (err) {
    log.error('intervention.failed', { callId: call.callId, message: describeError(err) });
  }

  if (call.interventionStop === stop) call.interventionStop = null;

  if (stop.aborted || call.ended || call.session.getState() === 'escalated') {
    log.info('intervention.aborted', { callId: call.callId, activityId: activity.id });
    return spoken.join(' ');
  }

  // El ultimo paso del guion ya pregunta "del cero al diez, cuanto bajo".
  call.awaitingRelief = activity.id;
  // El resumen entra al historial del modelo para que el siguiente turno sepa
  // que acaba de pasar, sin volcarle los 22 pasos de la respiracion.
  call.history.push({
    role: 'assistant',
    text: `[Acabamos de completar juntos: ${activity.title}. Le pregunte cuanto bajo del cero al diez.]`,
  });
  setState(call, 'listening');
  log.info('intervention.completed', { callId: call.callId, activityId: activity.id });

  return spoken.join(' ');
}

// =============================================================================
// 11. Turno conversacional (LLM)
// =============================================================================

/**
 * Envuelve el stream de deltas para saber cuando llega el PRIMERO.
 * Es lo que apaga el temporizador de la frase puente.
 */
async function* tapFirstDelta(
  source: AsyncIterable<string>,
  onFirst: () => void,
): AsyncIterable<string> {
  let seen = false;
  for await (const delta of source) {
    if (!seen) {
      seen = true;
      onFirst();
    }
    yield delta;
  }
}

async function runLlmTurn(
  call: ActiveCall,
  deps: PipelineDeps,
  startedAt: number,
): Promise<TurnResult> {
  const controller = new AbortController();
  call.llmAbort = controller;
  setState(call, 'thinking');

  const request: AgentTurnRequest = {
    systemPrompt: call.systemPrompt,
    messages: call.history.map((turn) => ({ role: turn.role, text: turn.text })),
  };

  let firstDeltaMs: number | null = null;
  let bridgeSpoken = false;
  const pieces: string[] = [];
  let blocked = 0;

  const queue = createSpeechQueue(call, deps, { startedAt, signal: controller.signal });

  const bridgeTimer = setTimeout(() => {
    if (firstDeltaMs !== null || controller.signal.aborted || call.ended) return;
    bridgeSpoken = true;
    log.info('llm.bridge', { callId: call.callId, afterMs: deps.bridgeMs });
    // La frase puente se oye pero NO entra al historial del modelo ni al
    // episodio: es relleno de latencia, no contenido clinico.
    call.sink.transcript('agent', BRIDGE_LINE, true);
    queue.push(BRIDGE_LINE);
  }, deps.bridgeMs);
  bridgeTimer.unref?.();

  let accumulated = '';
  try {
    const deltas = tapFirstDelta(deps.llm.streamReply(request, controller.signal), () => {
      firstDeltaMs = Date.now() - startedAt;
      clearTimeout(bridgeTimer);
    });

    for await (const chunk of splitIntoSpeakableChunks(deltas)) {
      if (controller.signal.aborted || call.ended) break;

      // POST-FILTRO DETERMINISTA, por frase, ANTES del TTS.
      // Se le pasa lo YA locutado en este turno como contexto: una frase
      // prohibida que el troceador parta en dos ("...no te preocupes," + "no es
      // nada.") es inocente mirando cada mitad por separado, y de otro modo
      // saldria entera por el altavoz.
      const inspected = inspectAgentChunk(chunk, accumulated);
      if (!inspected.safe) {
        blocked += 1;
        log.warn('output.blocked', {
          callId: call.callId,
          reason: inspected.reason,
          matched: inspected.matchedPhrase,
          straddled: inspected.straddled,
        });
      }

      pieces.push(inspected.text);
      accumulated = pieces.join(' ');
      if (call.session.getState() !== 'speaking') setState(call, 'speaking');
      call.sink.transcript('agent', accumulated, false);
      queue.push(inspected.text);
    }
  } catch (err) {
    // `withFallback` ya cubre el fallo del proveedor; esto es el ultimo cinturon.
    log.error('llm.failed', { callId: call.callId, message: describeError(err) });
  } finally {
    clearTimeout(bridgeTimer);
  }

  await queue.drain();
  const firstAudioMs = queue.firstAudioMs();

  const aborted = controller.signal.aborted;
  if (call.llmAbort === controller) call.llmAbort = null;

  const agentText = accumulated.trim();
  if (!aborted && !call.ended && agentText !== '') {
    call.session.addTurn('agent', agentText);
    call.history.push({ role: 'assistant', text: agentText });
    emitTranscriptTurn({ callId: call.callId, speaker: 'agent', text: agentText });
    call.sink.transcript('agent', agentText, true);
  }

  if (!aborted && !call.ended) setState(call, 'listening');

  // Se re-arma (o se desarma) la propuesta con lo que el agente REALMENTE dijo.
  // Si no propuso nada, el "si" del turno siguiente no arranca ninguna
  // intervencion: sera un "si" de conversacion, y se trata como tal.
  const guided = nextGuidedActivity(call);
  call.pendingActivityId =
    guided !== null && proposesIntervention(agentText, guided) ? guided.id : null;

  log.info('turn.agent', {
    callId: call.callId,
    provider: deps.llm.name,
    firstDeltaMs,
    firstAudioMs,
    blocked,
    bridge: bridgeSpoken,
    aborted,
    ...preview(agentText),
  });

  return result({
    path: 'llm',
    llmInvoked: true,
    agentText,
    firstAudioMs,
    totalMs: Date.now() - startedAt,
  });
}

// =============================================================================
// 12. Utilidades para el orquestador
// =============================================================================

/** Corta todo lo que este sonando. Lo usa `endCall`. */
export function abortEverything(call: ActiveCall): void {
  abortLlm(call);
  abortIntervention(call);
}
