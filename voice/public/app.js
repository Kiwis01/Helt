/**
 * =============================================================================
 *  loop-voice · Cliente de navegador (push-to-talk)
 *  Archivo: voice/public/app.js   (Agente G)
 * =============================================================================
 *
 * Pagina estatica servida por Fastify (@fastify/static) desde voice/public en
 * http://localhost:3002/. Sin build step, sin frameworks, sin CDN.
 *
 * =============================================================================
 *  PROTOCOLO WEBSOCKET  —  CONTRATO CON EL AGENTE DE INTEGRACION
 * =============================================================================
 *
 * Endpoint:  ws://localhost:3002/api/v1/call/stream
 *   (fallback automatico del cliente: /api/v1/call/socket, que es el nombre que
 *    aparece en shared/constants.ts -> API_PATHS.voice.callSocket. Si el
 *    servidor monta cualquiera de los dos, el cliente conecta. Preferido:
 *    /api/v1/call/stream. Override manual para pruebas: ?ws=/otra/ruta)
 *
 * Una conexion WebSocket = una llamada. Al cerrar el socket se cierra la
 * llamada; el servidor debe escribir el episodio igual que con {"type":"end"}.
 *
 * -----------------------------------------------------------------------------
 * 1. CLIENTE -> SERVIDOR
 * -----------------------------------------------------------------------------
 * Dos tipos de frame:
 *   a) TEXTO: siempre JSON con campo `type`.
 *   b) BINARIO: PCM crudo, sin cabecera, sin envoltorio. Ver mas abajo.
 *
 * (1.1) PRIMER mensaje, obligatorio, antes de cualquier frame binario:
 *   {
 *     "type": "start",
 *     "patientId": "loop-demo-patient-001",
 *     "audio": { "encoding": "linear16", "sampleRate": 16000, "channels": 1 },
 *     "client": "browser-ptt",
 *     "at": 1754074800000            // Date.now() del cliente, solo para logs
 *   }
 *   El servidor responde (opcional) con {"type":"ready"} y (recomendado) con
 *   {"type":"state","state":"greeting"|"listening"}.
 *   El campo `audio` describe lo que va a llegar por binario. Si el servidor
 *   necesita otro formato debe rechazarlo con {"type":"error"}; el cliente NO
 *   negocia formato.
 *
 * (1.2) FRAMES BINARIOS — el audio del microfono:
 *   PCM lineal, signed 16-bit, little-endian, MONO, 16000 Hz.
 *   Sin cabecera WAV. Sin base64. Un frame = 100 ms = 3200 bytes exactos.
 *   EXCEPCION: el ultimo frame de cada turno (el del flush al soltar el
 *   push-to-talk) puede ser mas corto. Siempre es un numero par de bytes.
 *   Se envian SOLO mientras el push-to-talk esta presionado, mas ese ultimo.
 *   Garantia de orden: el {"type":"stop"} del turno se manda SIEMPRE despues
 *   del ultimo frame binario de ese turno.
 *   Es exactamente lo que Deepgram Listen espera recibir: el servidor puede
 *   reenviarlos tal cual (encoding=linear16&sample_rate=16000&channels=1).
 *
 * (1.3) {"type":"speech-start","at":1754074800000}
 *   Se presiono el push-to-talk; empieza un turno del paciente.
 *   OPCIONAL de manejar: sirve para que el servidor emita state=listening y
 *   para marcar el inicio del turno en los logs. Si el servidor lo ignora, todo
 *   sigue funcionando (el primer frame binario ya implica inicio de habla).
 *
 * (1.4) {"type":"stop","at":1754074800000}
 *   Se solto el push-to-talk: fin del turno del paciente.
 *   OBLIGATORIO de manejar. El servidor debe mandar `Finalize` a Deepgram para
 *   cerrar el turno YA (no esperar al endpointing por silencio: en el escenario
 *   hay ruido y el VAD puede tardar). El transcript final resultante es lo que
 *   entra al motor de red-flags.
 *   Despues de un `stop` se puede volver a mandar audio binario (siguiente
 *   turno) sin repetir `start`.
 *
 * (1.5) {"type":"text","text":"me duele el pecho","at":1754074800000}
 *   MODO RESPALDO POR TEXTO. Si el microfono muere en el escenario, el demo
 *   sigue. OBLIGATORIO de manejar: se procesa por EXACTAMENTE el mismo camino
 *   que un transcript final de STT (red-flags -> LLM -> TTS), nunca por un
 *   atajo. El servidor PUEDE ecoar {"type":"transcript","speaker":"patient",
 *   "final":true} con ese mismo texto: el cliente deduplica.
 *
 * (1.6) {"type":"end","at":1754074800000}
 *   Colgar. El servidor cierra el turno, escribe el episodio en :3001 y
 *   responde {"type":"ended"}. OBLIGATORIO de manejar.
 *
 * (1.7) {"type":"ping","at":1754074800000}
 *   Keepalive cada 20 s. El servidor PUEDE ignorarlo o responder
 *   {"type":"pong","at":<mismo valor>}.
 *
 * REGLA: el servidor DEBE ignorar (no cerrar el socket) cualquier mensaje JSON
 * con un `type` que no conozca. Asi podemos anadir mensajes sin romper nada.
 *
 * -----------------------------------------------------------------------------
 * 2. SERVIDOR -> CLIENTE   (todo JSON en frames de TEXTO, nunca binario)
 * -----------------------------------------------------------------------------
 * REQUERIDOS:
 *
 * (2.1) {"type":"transcript","speaker":"patient"|"agent","text":"...","final":bool}
 *   `final:false` = parcial; reemplaza la burbuja viva de ese hablante.
 *   `final:true`  = turno cerrado; fija la burbuja y limpia la parcial.
 *   `text` es SIEMPRE el texto acumulado del turno, no un delta.
 *   El `final` del paciente arranca el cronometro de latencia del cliente.
 *
 * (2.2) {"type":"audio","mime":"audio/mpeg","data":"<base64>","seq":0}
 *   Audio del agente, por frases (no esperar al LLM completo).
 *   `mime` soportados por el cliente:
 *       audio/mpeg, audio/mp3          (Deepgram Aura-2, contenedor)
 *       audio/wav, audio/wave, audio/x-wav
 *       audio/ogg, audio/webm
 *       audio/l16;rate=24000  ·  audio/linear16;rate=24000  ·  audio/pcm;rate=24000
 *         (PCM crudo signed 16-bit LE mono; si falta `rate=` se asume 24000)
 *   `seq` es opcional pero recomendado (entero creciente por llamada): el
 *   cliente detecta huecos y los loguea. El ORDEN de llegada manda: la cola de
 *   reproduccion respeta el orden de recepcion, no el de `seq`.
 *   Los chunks se encolan y suenan SEGUIDOS, sin cortes ni solapamiento.
 *
 * (2.3) {"type":"state","state":"listening"}
 *   Estados aceptados (los mismos de CallState en voice/src/types.ts):
 *     idle · greeting · listening · thinking · speaking · intervention ·
 *     coverage · escalated · ended
 *   Alias aceptado: "intervening" -> "intervention".
 *   Un `state` desconocido no rompe la UI: se muestra crudo.
 *
 * (2.4) {"type":"escalation","rule":"RF-01-CHEST-PAIN-RADIATING",
 *        "action":"advise-911","script":"...","evidence":"se me va al brazo"}
 *   Dispara el banner rojo a pantalla completa con el ID de la regla enorme.
 *   `action` ∈ advise-911 | advise-988 | connect-human.
 *   `evidence` (opcional) = `matchedEvidence` del RedFlagResult. Mandalo: es lo
 *   que un juez clinico va a pedir ver.
 *   Se espera que el servidor mande ademas el `script` como audio (2.2) y como
 *   transcript de agente (2.1). El banner NO depende de eso.
 *
 * (2.5) {"type":"ended","outcome":"escalated-emergency","encounterId":"enc-0042",
 *        "medplumUrl":"https://app.medplum.com/Encounter/..."}
 *   `outcome` ∈ resolved-with-intervention | self-resolved | escalated-emergency
 *              | escalated-human | abandoned
 *   `encounterId` y `medplumUrl` pueden ser null (p.ej. :3001 caido): la UI lo
 *   muestra como "episodio no persistido" y NO se rompe.
 *
 * (2.6) {"type":"error","message":"...","fatal":false}
 *   Se muestra como toast. `fatal:true` ademas marca la llamada como caida.
 *   Un error NO fatal nunca debe cerrar el socket: la llamada nunca se cae.
 *
 * OPCIONALES (si no llegan, la UI queda en su estado neutro):
 *
 * (2.7) {"type":"ready","callId":"call-8f2a","patientId":"...",
 *        "displayName":"Alex Rivera","age":34,
 *        "biometrics":{"heartRate":118,"hrv":21,"respiratoryRate":24},
 *        "baseline":{"heartRate":68,"hrv":54,"respiratoryRate":14},
 *        "useMocks":true}
 *   Rellena la cabecera con el paciente y las tarjetas de biometria. Mandalo en
 *   cuanto el contexto este precargado: es lo que prueba que hay datos reales.
 *
 * (2.8) {"type":"biometrics","heartRate":121,"hrv":19,"respiratoryRate":26}
 *   Tick de biometria en vivo. Actualiza las tarjetas.
 *
 * (2.9) {"type":"coverage","status":"covered","voiceSummary":"...",
 *        "copayCents":2500,"payerName":"Test Payer Inc"}
 *   Pinta una tarjeta de cobertura en el transcript. `voiceSummary` se muestra
 *   LITERAL, sin tocarlo.
 *
 * (2.10) {"type":"pong","at":...}  — respuesta al ping. Se ignora en silencio.
 *
 * =============================================================================
 */

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

const PRIMARY_WS_PATH = '/api/v1/call/stream';
const FALLBACK_WS_PATH = '/api/v1/call/socket';

const DEFAULT_PATIENT_ID = 'loop-demo-patient-001';

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_MS = 100;

/** Colchon antes del primer chunk agendado, para absorber el jitter de red. */
const PLAYBACK_LEAD_SECONDS = 0.06;

/** Si `ended` no llega tras colgar, cerramos la UI igual. */
const END_TIMEOUT_MS = 4000;

/**
 * Plazo para que el socket abra. Todo esto es localhost: o abre casi al
 * instante o no va a abrir. Sin este plazo el navegador puede tardar 5-6 s en
 * dar el error y en el escenario eso se ve como si la app se hubiera colgado.
 */
const CONNECT_TIMEOUT_MS = 3500;

const PING_INTERVAL_MS = 20000;

/** Ventana para deduplicar el eco del servidor al mandar texto de respaldo. */
const TEXT_ECHO_WINDOW_MS = 4000;

const STATE_LABELS = {
  idle: ['En espera', 'Llamada no iniciada'],
  connecting: ['Conectando', 'Abriendo el socket de la llamada'],
  greeting: ['Saludando', 'Disclosure y contexto inicial'],
  listening: ['Escuchando', 'Manten el push-to-talk para hablar'],
  thinking: ['Pensando', 'Red-flags evaluadas · consultando el modelo'],
  speaking: ['Hablando', 'Reproduciendo respuesta del agente'],
  intervention: ['Guiando intervencion', 'Care plan con timing real'],
  coverage: ['Verificando cobertura', 'Consultando loop-coverage (:3003)'],
  escalated: ['ESCALADO', 'Regla determinista disparada · el LLM no intervino'],
  ended: ['Finalizada', 'Episodio cerrado'],
  error: ['Error', 'Revisa la consola del servidor'],
};

const OUTCOME_LABELS = {
  'resolved-with-intervention': 'Resuelto con intervencion',
  'self-resolved': 'Resuelto por si mismo',
  'escalated-emergency': 'Escalado a emergencia',
  'escalated-human': 'Escalado a humano',
  abandoned: 'Abandonado',
};

const ACTION_LABELS = {
  'advise-911': '911',
  'advise-988': '988',
  'connect-human': 'HUMANO',
};

// -----------------------------------------------------------------------------
// Referencias al DOM
// -----------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const dom = {
  connChip: $('connChip'),
  connText: $('connText'),
  patientChip: $('patientChip'),
  patientInitials: $('patientInitials'),
  patientName: $('patientName'),
  patientMeta: $('patientMeta'),
  latencyValue: $('latencyValue'),
  latencySub: $('latencySub'),
  latencyCard: $('latencyCard'),

  escalationBanner: $('escalationBanner'),
  escRule: $('escRule'),
  escAction: $('escAction'),
  escScript: $('escScript'),
  escEvidence: $('escEvidence'),

  transcript: $('transcript'),
  transcriptEmpty: $('transcriptEmpty'),
  turnCount: $('turnCount'),

  stateDot: $('stateDot'),
  stateLabel: $('stateLabel'),
  stateHint: $('stateHint'),

  bioMeta: $('bioMeta'),
  bioHr: $('bioHr'),
  bioHrv: $('bioHrv'),
  bioRr: $('bioRr'),
  bioHrBase: $('bioHrBase'),
  bioHrvBase: $('bioHrvBase'),
  bioRrBase: $('bioRrBase'),

  rulesList: $('rulesList'),
  rulesBadge: $('rulesBadge'),

  resultPanel: $('resultPanel'),
  resultOutcome: $('resultOutcome'),
  resultEncounter: $('resultEncounter'),
  resultLink: $('resultLink'),

  pttBtn: $('pttBtn'),
  pttLabel: $('pttLabel'),
  pttHint: $('pttHint'),
  levelMeter: $('levelMeter'),

  textForm: $('textForm'),
  textInput: $('textInput'),
  textSend: $('textSend'),

  startBtn: $('startBtn'),
  endBtn: $('endBtn'),

  toastStack: $('toastStack'),
};

// -----------------------------------------------------------------------------
// Estado de la aplicacion
// -----------------------------------------------------------------------------

const state = {
  /** 'offline' | 'connecting' | 'online' | 'ended' | 'failed' */
  connection: 'offline',
  callActive: false,
  talking: false,
  micReady: false,
  triedFallbackPath: false,
  turns: 0,
  audioSeq: null,
  /** Marca de tiempo del ultimo final del paciente (t0 de la latencia). */
  latencyT0: null,
  latencyPending: false,
  lastLatencyMs: null,
  bestLatencyMs: null,
  /** Ultimo texto mandado por el modo respaldo, para deduplicar el eco. */
  lastLocalText: null,
  lastLocalTextAt: 0,
  endTimer: null,
  pingTimer: null,
  /** Hay un {"type":"stop"} pendiente de mandar tras el flush del worklet. */
  pendingStop: false,
  stopTimer: null,
};

/** Burbujas parciales vivas, una por hablante. */
const livePartials = { patient: null, agent: null };

let socket = null;

// Audio de captura
let audioContext = null;
let micStream = null;
let micSource = null;
let workletNode = null;

/** Nivel de microfono suavizado para el medidor (0..1). */
let micLevel = 0;
let levelRafId = null;

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

const patientId = new URLSearchParams(location.search).get('patient') || DEFAULT_PATIENT_ID;

function buildWsUrl(path) {
  const override = new URLSearchParams(location.search).get('ws');
  const finalPath = override || path;
  if (/^wss?:\/\//i.test(finalPath)) return finalPath;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${finalPath}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function initialsOf(name) {
  if (!name) return '—';
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

/** Normaliza para comparar el eco del modo texto: sin acentos, sin puntuacion. */
function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // marcas de acento sueltas tras NFD
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let toastId = 0;

/**
 * Aviso efimero. `kind`: 'error' | 'warn' | 'info'.
 * Los errores no fatales viven 6 s; el resto 4 s.
 */
function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  const id = ++toastId;
  el.dataset.toastId = String(id);
  dom.toastStack.appendChild(el);
  const ttl = kind === 'error' ? 6000 : 4000;
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 320);
  }, ttl);
}

// -----------------------------------------------------------------------------
// Cola de reproduccion del audio del agente
// -----------------------------------------------------------------------------

/**
 * Cola real, no `new Audio()` suelto por frase.
 *
 * Dos problemas que resuelve:
 *   1. `decodeAudioData` es asincrono y no garantiza terminar en orden, asi que
 *      la decodificacion se serializa en una cadena de promesas: el chunk N+1
 *      no se agenda hasta que el N ya reservo su hueco en la linea de tiempo.
 *   2. Agendar con `start(0)` mete solapamientos y silencios. Se lleva un cursor
 *      en el reloj del AudioContext y cada buffer arranca exactamente donde
 *      termino el anterior -> las frases suenan seguidas.
 */
class AgentAudioQueue {
  constructor() {
    this.chain = Promise.resolve();
    this.cursor = 0;
    this.active = new Set();
    this.gain = null;
    this.pending = 0;
    /** Traza de los ultimos chunks agendados. Ver `window.loopVoiceDebug`. */
    this.trace = [];
  }

  ensureGain(ctx) {
    if (!this.gain || this.gain.context !== ctx) {
      this.gain = ctx.createGain();
      this.gain.gain.value = 1;
      this.gain.connect(ctx.destination);
    }
    return this.gain;
  }

  /** @param {string} mime @param {Uint8Array} bytes */
  push(mime, bytes) {
    this.pending += 1;
    this.chain = this.chain
      .then(() => this.schedule(mime, bytes))
      .catch((err) => {
        console.error('[audio] no se pudo reproducir un chunk', err);
        toast('Un fragmento de audio no se pudo reproducir', 'warn');
      })
      .finally(() => {
        this.pending = Math.max(0, this.pending - 1);
      });
  }

  async schedule(mime, bytes) {
    const ctx = await ensureAudioContext();
    if (!ctx) throw new Error('sin AudioContext');
    const gain = this.ensureGain(ctx);

    const buffer = isRawPcmMime(mime)
      ? pcmToAudioBuffer(ctx, bytes, rateFromMime(mime))
      : await ctx.decodeAudioData(bytes.buffer);

    const now = ctx.currentTime;
    const startAt = Math.max(now + PLAYBACK_LEAD_SECONDS, this.cursor);

    // Traza de diagnostico: `gap` debe ser 0 entre frases de un mismo bloque.
    // Si es > 0 es que el TTS llego tarde y se oye un silencio.
    this.trace.push({
      mime,
      seconds: Number(buffer.duration.toFixed(4)),
      gap: Number(Math.max(0, startAt - this.cursor).toFixed(4)),
    });
    if (this.trace.length > 40) this.trace.shift();

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start(startAt);

    this.cursor = startAt + buffer.duration;
    this.active.add(source);
    source.onended = () => this.active.delete(source);
  }

  /** Corta todo lo que suene y vacia la cola (al colgar o al escalar). */
  stopAll() {
    for (const source of this.active) {
      try {
        source.stop();
      } catch {
        /* ya habia terminado */
      }
    }
    this.active.clear();
    this.cursor = 0;
    this.chain = Promise.resolve();
    this.pending = 0;
    this.trace = [];
  }
}

const agentAudio = new AgentAudioQueue();

function isRawPcmMime(mime) {
  const value = String(mime || '').toLowerCase();
  return value.includes('l16') || value.includes('linear16') || value.includes('pcm');
}

function rateFromMime(mime) {
  const match = /rate=(\d+)/i.exec(String(mime || ''));
  const rate = match ? Number(match[1]) : NaN;
  return Number.isFinite(rate) && rate >= 8000 && rate <= 96000 ? rate : 24000;
}

/** PCM signed 16-bit LE mono -> AudioBuffer. El resampleo lo hace el grafo. */
function pcmToAudioBuffer(ctx, bytes, sampleRate) {
  const usableBytes = bytes.byteLength - (bytes.byteLength % 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, usableBytes);
  const frames = usableBytes / 2;
  const buffer = ctx.createBuffer(1, Math.max(1, frames), sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) {
    channel[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return buffer;
}

// -----------------------------------------------------------------------------
// AudioContext (compartido por captura y reproduccion)
// -----------------------------------------------------------------------------

async function ensureAudioContext() {
  if (!audioContext) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioContext = new Ctor();
  }
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
    } catch (err) {
      console.warn('[audio] no se pudo reanudar el AudioContext', err);
    }
  }
  return audioContext;
}

// -----------------------------------------------------------------------------
// Captura de microfono
// -----------------------------------------------------------------------------

async function setupMicrophone() {
  const ctx = await ensureAudioContext();
  if (!ctx) throw new Error('Este navegador no soporta Web Audio');

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 48000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });

  await ctx.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));

  micSource = ctx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(ctx, 'pcm-capture-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE, chunkMs: CHUNK_MS },
  });

  workletNode.port.onmessage = (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'audio') {
      // La compuerta real del push-to-talk esta en el worklet. Aqui se mira
      // `callActive` y NO `talking`: el ultimo chunk (el del flush) llega
      // cuando el boton ya se solto, y ese es justo el que no se puede perder.
      if (state.callActive && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(msg.buffer);
      }
      return;
    }
    if (msg.type === 'flush-done') {
      sendStopNow();
      return;
    }
    if (msg.type === 'level') {
      micLevel = clamp(Number(msg.rms) || 0, 0, 1);
    }
  };

  // El nodo no tiene salida (numberOfOutputs: 0), asi que nada llega al altavoz:
  // cero riesgo de realimentacion con el TTS del agente.
  micSource.connect(workletNode);

  state.micReady = true;
  startLevelLoop();
}

function teardownMicrophone() {
  stopLevelLoop();
  try {
    if (workletNode) {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    }
    if (micSource) micSource.disconnect();
    if (micStream) micStream.getTracks().forEach((track) => track.stop());
  } catch (err) {
    console.warn('[mic] error al liberar el microfono', err);
  }
  workletNode = null;
  micSource = null;
  micStream = null;
  state.micReady = false;
}

function setCapture(on) {
  if (workletNode) workletNode.port.postMessage({ type: 'capture', on });
}

function flushCapture() {
  if (workletNode) workletNode.port.postMessage({ type: 'flush' });
}

// -----------------------------------------------------------------------------
// Medidor de nivel
// -----------------------------------------------------------------------------

const LEVEL_SEGMENTS = 28;

function buildLevelMeter() {
  dom.levelMeter.replaceChildren();
  for (let i = 0; i < LEVEL_SEGMENTS; i += 1) {
    const seg = document.createElement('span');
    seg.className = 'level-seg';
    // Los ultimos segmentos son la zona alta: se pintan ambar/rojo al llegar.
    if (i >= LEVEL_SEGMENTS - 4) seg.dataset.zone = 'hot';
    else if (i >= LEVEL_SEGMENTS - 9) seg.dataset.zone = 'warm';
    dom.levelMeter.appendChild(seg);
  }
}

/** RMS lineal -> porcentaje perceptual (-60 dBFS = 0, 0 dBFS = 100). */
function levelToPercent(rms) {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return clamp(((db + 60) / 60) * 100, 0, 100);
}

function startLevelLoop() {
  if (levelRafId !== null) return;
  let displayed = 0;
  const tick = () => {
    const target = state.talking ? levelToPercent(micLevel) : 0;
    // Suavizado extra en el hilo de render: sube rapido, baja suave.
    displayed = target > displayed ? target : displayed * 0.85 + target * 0.15;
    const lit = Math.round((displayed / 100) * LEVEL_SEGMENTS);
    const segments = dom.levelMeter.children;
    for (let i = 0; i < segments.length; i += 1) {
      segments[i].classList.toggle('is-on', i < lit);
    }
    levelRafId = requestAnimationFrame(tick);
  };
  levelRafId = requestAnimationFrame(tick);
}

function stopLevelLoop() {
  if (levelRafId !== null) cancelAnimationFrame(levelRafId);
  levelRafId = null;
  micLevel = 0;
  for (const seg of dom.levelMeter.children) seg.classList.remove('is-on');
}

// -----------------------------------------------------------------------------
// Transcript
// -----------------------------------------------------------------------------

function hideEmptyState() {
  if (dom.transcriptEmpty && !dom.transcriptEmpty.hidden) dom.transcriptEmpty.hidden = true;
}

function scrollTranscriptToBottom() {
  dom.transcript.scrollTop = dom.transcript.scrollHeight;
}

function nowLabel() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;
}

function createBubble(speaker) {
  const wrapper = document.createElement('article');
  wrapper.className = `bubble bubble-${speaker}`;

  const head = document.createElement('header');
  head.className = 'bubble-head';
  const who = document.createElement('span');
  who.className = 'bubble-who';
  who.textContent = speaker === 'patient' ? 'Paciente' : 'Agente';
  const time = document.createElement('span');
  time.className = 'bubble-time';
  time.textContent = nowLabel();
  head.append(who, time);

  const body = document.createElement('p');
  body.className = 'bubble-text';

  wrapper.append(head, body);
  dom.transcript.appendChild(wrapper);
  hideEmptyState();
  return { wrapper, body };
}

/**
 * Aplica un mensaje de transcript.
 * Los parciales reemplazan la burbuja viva de ese hablante; el final la fija.
 */
function applyTranscript(speaker, text, final) {
  const who = speaker === 'agent' ? 'agent' : 'patient';

  if (who === 'patient' && final && isEchoOfLocalText(text)) return;

  let entry = livePartials[who];
  if (!entry) {
    entry = createBubble(who);
    livePartials[who] = entry;
  }

  entry.body.textContent = text;
  entry.wrapper.classList.toggle('is-partial', !final);

  if (final) {
    livePartials[who] = null;
    state.turns += 1;
    dom.turnCount.textContent = `${state.turns} ${state.turns === 1 ? 'turno' : 'turnos'}`;
    if (who === 'patient') markLatencyStart();
  }

  scrollTranscriptToBottom();
}

/** Evita duplicar la burbuja cuando el servidor ecoa el texto de respaldo. */
function isEchoOfLocalText(text) {
  if (!state.lastLocalText) return false;
  if (Date.now() - state.lastLocalTextAt > TEXT_ECHO_WINDOW_MS) return false;
  if (normalizeText(text) !== state.lastLocalText) return false;
  state.lastLocalText = null;
  return true;
}

/** Tarjeta de sistema en el hilo del transcript (cobertura, fin, avisos). */
function addSystemCard(kind, title, lines) {
  const card = document.createElement('article');
  card.className = `sys-card sys-${kind}`;

  const head = document.createElement('header');
  head.className = 'sys-head';
  head.textContent = title;
  card.appendChild(head);

  for (const line of lines.filter(Boolean)) {
    const p = document.createElement('p');
    p.className = 'sys-line';
    p.textContent = line;
    card.appendChild(p);
  }

  dom.transcript.appendChild(card);
  hideEmptyState();
  scrollTranscriptToBottom();
}

// -----------------------------------------------------------------------------
// Latencia
// -----------------------------------------------------------------------------

function markLatencyStart() {
  state.latencyT0 = performance.now();
  state.latencyPending = true;
  dom.latencyCard.dataset.status = 'measuring';
  dom.latencySub.textContent = 'midiendo…';
}

function markLatencyFirstAudio() {
  if (!state.latencyPending || state.latencyT0 === null) return;
  const ms = Math.round(performance.now() - state.latencyT0);
  state.latencyPending = false;
  state.lastLatencyMs = ms;
  state.bestLatencyMs = state.bestLatencyMs === null ? ms : Math.min(state.bestLatencyMs, ms);

  dom.latencyValue.textContent = String(ms);
  dom.latencyCard.dataset.status = ms < 800 ? 'good' : ms < 1500 ? 'warn' : 'bad';
  dom.latencySub.textContent = `mejor ${state.bestLatencyMs} ms · objetivo < 800`;
}

function resetLatency() {
  state.latencyT0 = null;
  state.latencyPending = false;
  state.lastLatencyMs = null;
  state.bestLatencyMs = null;
  dom.latencyValue.textContent = '—';
  dom.latencySub.textContent = 'objetivo < 800 ms';
  delete dom.latencyCard.dataset.status;
}

// -----------------------------------------------------------------------------
// Indicadores de UI
// -----------------------------------------------------------------------------

function setConnection(kind, text) {
  state.connection = kind;
  dom.connChip.dataset.conn = kind;
  dom.connText.textContent = text;
}

function setAgentState(rawState) {
  const key = rawState === 'intervening' ? 'intervention' : rawState;
  const entry = STATE_LABELS[key];
  dom.stateDot.dataset.state = STATE_LABELS[key] ? key : 'unknown';
  if (entry) {
    dom.stateLabel.textContent = entry[0];
    dom.stateHint.textContent = entry[1];
  } else {
    dom.stateLabel.textContent = String(rawState);
    dom.stateHint.textContent = 'Estado no reconocido por el cliente';
  }
}

function setPatientHeader(payload) {
  const name = payload.displayName || payload.patientName;
  if (name) {
    dom.patientChip.classList.remove('is-empty');
    dom.patientName.textContent = name;
    dom.patientInitials.textContent = initialsOf(name);
  }
  const bits = [];
  if (payload.age) bits.push(`${payload.age} anos`);
  if (payload.callId) bits.push(payload.callId);
  bits.push(payload.patientId || patientId);
  if (payload.useMocks === true) bits.push('mocks');
  dom.patientMeta.textContent = bits.join(' · ');
}

function setBiometrics(current, baseline) {
  const fields = [
    ['heartRate', dom.bioHr, dom.bioHrBase, ''],
    ['hrv', dom.bioHrv, dom.bioHrvBase, ''],
    ['respiratoryRate', dom.bioRr, dom.bioRrBase, ''],
  ];
  let any = false;
  for (const [key, valueEl, baseEl] of fields) {
    const value = current ? current[key] : undefined;
    if (typeof value === 'number' && Number.isFinite(value)) {
      valueEl.textContent = String(Math.round(value));
      any = true;
    }
    const base = baseline ? baseline[key] : undefined;
    if (typeof base === 'number' && Number.isFinite(base)) {
      baseEl.textContent = `baseline ${Math.round(base)}`;
      const cur = typeof value === 'number' ? value : null;
      if (cur !== null && base > 0) {
        const ratio = cur / base;
        valueEl.dataset.trend = ratio > 1.25 ? 'high' : ratio < 0.75 ? 'low' : 'normal';
      }
    }
  }
  if (any) dom.bioMeta.textContent = `actualizado ${nowLabel()}`;
}

function showEscalation(payload) {
  const rule = payload.rule || payload.ruleId || 'RF-??';
  dom.escRule.textContent = rule;
  dom.escAction.textContent = ACTION_LABELS[payload.action] || String(payload.action || '—');
  dom.escAction.dataset.action = payload.action || '';
  dom.escScript.textContent = payload.script || '';
  if (payload.evidence || payload.matchedEvidence) {
    dom.escEvidence.textContent = `Evidencia: “${payload.evidence || payload.matchedEvidence}”`;
    dom.escEvidence.hidden = false;
  } else {
    dom.escEvidence.hidden = true;
  }
  dom.escalationBanner.hidden = false;
  document.body.classList.add('is-escalated');

  // Se enciende la regla concreta en el listado del panel lateral. Si la lista
  // esta recortada (el banner le come alto), se desplaza hasta la regla.
  for (const li of dom.rulesList.children) {
    const isFired = li.dataset.rule === rule;
    li.classList.toggle('is-fired', isFired);
    if (isFired) li.scrollIntoView({ block: 'nearest' });
  }
  dom.rulesBadge.textContent = 'DISPARADO';
  dom.rulesBadge.classList.add('badge-fired');

  addSystemCard('escalation', `Escalacion · ${rule}`, [
    payload.script || '',
    payload.evidence || payload.matchedEvidence
      ? `Evidencia: ${payload.evidence || payload.matchedEvidence}`
      : '',
    'Regla determinista evaluada antes del LLM.',
  ]);

  setAgentState('escalated');
}

function clearEscalation() {
  dom.escalationBanner.hidden = true;
  document.body.classList.remove('is-escalated');
  for (const li of dom.rulesList.children) li.classList.remove('is-fired');
  dom.rulesBadge.textContent = 'ARMADO';
  dom.rulesBadge.classList.remove('badge-fired');
}

function showResult(payload) {
  const outcome = payload.outcome || 'abandoned';
  dom.resultOutcome.textContent = OUTCOME_LABELS[outcome] || outcome;
  dom.resultOutcome.dataset.outcome = outcome;

  if (payload.encounterId) {
    dom.resultEncounter.textContent = `Encounter ${payload.encounterId}`;
  } else {
    dom.resultEncounter.textContent = 'Episodio no persistido (loop-core no respondio)';
  }

  if (payload.medplumUrl) {
    dom.resultLink.href = payload.medplumUrl;
    dom.resultLink.hidden = false;
  } else {
    dom.resultLink.hidden = true;
  }

  dom.resultPanel.hidden = false;

  addSystemCard('result', 'Llamada finalizada', [
    `Outcome: ${OUTCOME_LABELS[outcome] || outcome}`,
    payload.encounterId ? `Encounter: ${payload.encounterId}` : 'Sin encounterId',
  ]);
}

// -----------------------------------------------------------------------------
// Habilitacion de controles
// -----------------------------------------------------------------------------

function refreshControls() {
  const online = state.connection === 'online';
  dom.pttBtn.disabled = !online || !state.micReady;
  dom.textInput.disabled = !online;
  dom.textSend.disabled = !online;
  dom.endBtn.disabled = !online;
  dom.startBtn.disabled = state.connection === 'connecting' || online;

  if (!state.micReady && online) {
    dom.pttLabel.textContent = 'Microfono no disponible';
    dom.pttHint.textContent = 'usa el modo texto de abajo';
  } else if (state.talking) {
    dom.pttLabel.textContent = 'Escuchando…';
    dom.pttHint.textContent = 'suelta para enviar el turno';
  } else {
    dom.pttLabel.textContent = 'Manten para hablar';
    dom.pttHint.textContent = 'o la barra espaciadora';
  }
}

// -----------------------------------------------------------------------------
// WebSocket
// -----------------------------------------------------------------------------

function sendJson(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function connect(path) {
  const url = buildWsUrl(path);
  setConnection('connecting', 'Conectando…');
  setAgentState('connecting');
  refreshControls();

  let opened = false;

  try {
    socket = new WebSocket(url);
  } catch (err) {
    console.error('[ws] no se pudo crear el socket', err);
    handleConnectFailure(path);
    return;
  }

  socket.binaryType = 'arraybuffer';

  const openTimer = setTimeout(() => {
    if (opened) return;
    console.warn(`[ws] ${url} no abrio en ${CONNECT_TIMEOUT_MS} ms`);
    // El close dispara onclose con opened=false -> handleConnectFailure.
    try {
      socket.close();
    } catch {
      /* ya estaba cerrado */
    }
  }, CONNECT_TIMEOUT_MS);

  socket.onopen = () => {
    opened = true;
    clearTimeout(openTimer);
    state.triedFallbackPath = false;
    setConnection('online', 'En llamada');
    state.callActive = true;
    sendJson({
      type: 'start',
      patientId,
      audio: { encoding: 'linear16', sampleRate: TARGET_SAMPLE_RATE, channels: 1 },
      client: 'browser-ptt',
      at: Date.now(),
    });
    setAgentState('greeting');
    refreshControls();
    startPing();
  };

  socket.onmessage = (event) => {
    if (typeof event.data !== 'string') {
      // El servidor no manda binario en este protocolo. Se ignora sin romper.
      console.warn('[ws] frame binario inesperado del servidor, ignorado');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      console.error('[ws] JSON invalido del servidor', event.data);
      return;
    }
    handleServerMessage(msg);
  };

  socket.onerror = () => {
    // `onerror` no trae detalle util por seguridad del navegador; el diagnostico
    // real llega en `onclose`.
    console.warn('[ws] error de socket');
  };

  socket.onclose = (event) => {
    clearTimeout(openTimer);
    stopPing();
    if (!opened) {
      handleConnectFailure(path);
      return;
    }
    const wasActive = state.callActive;
    state.callActive = false;
    stopTalking(true);
    setConnection(state.connection === 'ended' ? 'ended' : 'offline',
      state.connection === 'ended' ? 'Llamada finalizada' : 'Desconectado');
    if (wasActive && state.connection !== 'ended') {
      setAgentState('idle');
      toast(`La conexion se cerro (codigo ${event.code}). Pulsa Iniciar llamada para reconectar.`, 'error');
    }
    refreshControls();
  };
}

/**
 * El socket nunca llego a abrirse. Se intenta la ruta alternativa una sola vez:
 * shared/constants.ts nombra el endpoint `/api/v1/call/socket` y este cliente
 * prefiere `/api/v1/call/stream`. Con esto conecta con cualquiera de las dos y
 * el demo no depende de que coincidamos en el nombre.
 */
function handleConnectFailure(path) {
  if (!state.triedFallbackPath && path === PRIMARY_WS_PATH && !new URLSearchParams(location.search).get('ws')) {
    state.triedFallbackPath = true;
    console.warn(`[ws] ${PRIMARY_WS_PATH} no respondio, probando ${FALLBACK_WS_PATH}`);
    connect(FALLBACK_WS_PATH);
    return;
  }
  setConnection('failed', 'Sin conexion');
  setAgentState('error');
  state.callActive = false;
  refreshControls();
  toast('No se pudo abrir el WebSocket de la llamada. ¿Esta corriendo loop-voice en :3002?', 'error');
}

function startPing() {
  stopPing();
  state.pingTimer = setInterval(() => {
    sendJson({ type: 'ping', at: Date.now() });
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (state.pingTimer) clearInterval(state.pingTimer);
  state.pingTimer = null;
}

// -----------------------------------------------------------------------------
// Manejo de mensajes del servidor
// -----------------------------------------------------------------------------

function handleServerMessage(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    console.warn('[ws] mensaje sin type', msg);
    return;
  }

  switch (msg.type) {
    case 'transcript':
      applyTranscript(msg.speaker, String(msg.text ?? ''), Boolean(msg.final));
      break;

    case 'audio': {
      if (typeof msg.data !== 'string' || msg.data.length === 0) {
        console.warn('[ws] chunk de audio sin data');
        break;
      }
      if (typeof msg.seq === 'number') {
        if (state.audioSeq !== null && msg.seq !== state.audioSeq + 1) {
          console.warn(`[audio] hueco de secuencia: esperaba ${state.audioSeq + 1}, llego ${msg.seq}`);
        }
        state.audioSeq = msg.seq;
      }
      markLatencyFirstAudio();
      try {
        agentAudio.push(msg.mime || 'audio/mpeg', base64ToBytes(msg.data));
      } catch (err) {
        console.error('[audio] base64 invalido', err);
      }
      break;
    }

    case 'state':
      setAgentState(String(msg.state || 'idle'));
      break;

    case 'escalation':
      showEscalation(msg);
      break;

    case 'ended':
      finishCall(msg);
      break;

    case 'error':
      console.error('[servidor]', msg.message);
      toast(String(msg.message || 'Error en el servidor'), 'error');
      if (msg.fatal) {
        setAgentState('error');
        setConnection('failed', 'Error');
        refreshControls();
      }
      break;

    // ---- opcionales -------------------------------------------------------
    case 'ready':
      setPatientHeader(msg);
      setBiometrics(msg.biometrics, msg.baseline);
      if (msg.callId) console.info(`[llamada] ${msg.callId}`);
      break;

    case 'biometrics':
      setBiometrics(msg, null);
      break;

    case 'coverage':
      addSystemCard('coverage', `Cobertura · ${msg.status || 'desconocida'}`, [
        msg.voiceSummary || '',
        typeof msg.copayCents === 'number' ? `Copago: ${(msg.copayCents / 100).toFixed(2)} USD` : '',
        msg.payerName || '',
      ]);
      break;

    case 'pong':
      break;

    default:
      console.info('[ws] tipo de mensaje no manejado:', msg.type);
  }
}

// -----------------------------------------------------------------------------
// Push-to-talk
// -----------------------------------------------------------------------------

function startTalking() {
  if (state.talking) return;
  if (state.connection !== 'online' || !state.micReady) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  state.talking = true;
  dom.pttBtn.classList.add('is-active');
  document.body.classList.add('is-talking');
  setCapture(true);
  sendJson({ type: 'speech-start', at: Date.now() });
  refreshControls();
}

/**
 * Manda el {"type":"stop"} una sola vez por turno.
 * Se llama desde el acuse `flush-done` del worklet (camino normal) o desde el
 * temporizador de respaldo si ese acuse no llega.
 */
function sendStopNow() {
  if (!state.pendingStop) return;
  state.pendingStop = false;
  if (state.stopTimer) {
    clearTimeout(state.stopTimer);
    state.stopTimer = null;
  }
  sendJson({ type: 'stop', at: Date.now() });
}

/** @param {boolean} silent true cuando se corta por desconexion, no por el usuario. */
function stopTalking(silent = false) {
  if (!state.talking) return;
  state.talking = false;
  dom.pttBtn.classList.remove('is-active');
  document.body.classList.remove('is-talking');

  if (silent) {
    // Corte por desconexion o por perdida de foco: nada que anunciar.
    state.pendingStop = false;
    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = null;
    }
    setCapture(false);
    refreshControls();
    return;
  }

  state.pendingStop = true;

  if (workletNode) {
    // Orden obligatorio: flush (ultimas muestras) -> capture:false (descarta el
    // resto). El `stop` sale cuando el worklet acusa el flush, nunca antes: si
    // saliera antes, el servidor haria Finalize sin la cola del turno.
    flushCapture();
    setCapture(false);
    // Respaldo por si el worklet muriera: el turno se cierra igual.
    state.stopTimer = setTimeout(sendStopNow, 200);
  } else {
    // Sin microfono no hay nada que vaciar.
    sendStopNow();
  }

  refreshControls();
}

// -----------------------------------------------------------------------------
// Ciclo de la llamada
// -----------------------------------------------------------------------------

async function startCall() {
  if (state.connection === 'connecting' || state.connection === 'online') return;

  // Reset de la UI para una llamada limpia (util al ensayar el demo en bucle).
  clearEscalation();
  resetLatency();
  dom.resultPanel.hidden = true;
  dom.transcript.replaceChildren(dom.transcriptEmpty);
  dom.transcriptEmpty.hidden = false;
  livePartials.patient = null;
  livePartials.agent = null;
  state.turns = 0;
  state.audioSeq = null;
  dom.turnCount.textContent = '0 turnos';
  agentAudio.stopAll();

  // El AudioContext se crea dentro del gesto del usuario: sin esto la politica
  // de autoplay del navegador deja el audio del agente en silencio.
  await ensureAudioContext();

  // El socket PRIMERO y el microfono despues, en paralelo y sin await.
  // getUserMedia puede quedarse colgado en el prompt de permisos del navegador
  // y no queremos que eso retrase el saludo del agente en el escenario.
  state.triedFallbackPath = false;
  connect(PRIMARY_WS_PATH);

  // El microfono es best-effort: si falla, la llamada sigue en modo texto.
  if (!state.micReady) {
    setupMicrophone()
      .then(() => refreshControls())
      .catch((err) => {
        console.error('[mic] no disponible', err);
        const reason = err && err.name === 'NotAllowedError'
          ? 'Permiso de microfono denegado'
          : 'No se pudo abrir el microfono';
        toast(`${reason}. Modo respaldo por texto activo.`, 'warn');
        refreshControls();
      });
  }
}

function endCall() {
  if (state.connection !== 'online') return;
  stopTalking();
  sendJson({ type: 'end', at: Date.now() });
  setAgentState('ended');
  dom.endBtn.disabled = true;

  // Si el servidor no confirma, cerramos igual: la UI nunca se queda colgada.
  state.endTimer = setTimeout(() => {
    if (state.connection === 'online') {
      toast('El servidor no confirmo el cierre. Llamada terminada localmente.', 'warn');
      finishCall({ outcome: 'abandoned', encounterId: null });
    }
  }, END_TIMEOUT_MS);
}

function finishCall(payload) {
  if (state.endTimer) {
    clearTimeout(state.endTimer);
    state.endTimer = null;
  }
  state.callActive = false;
  stopTalking(true);
  setConnection('ended', 'Llamada finalizada');
  setAgentState('ended');
  showResult(payload || {});
  refreshControls();
  dom.startBtn.disabled = false;
  dom.startBtn.textContent = 'Nueva llamada';

  // Se deja que termine de sonar el audio en cola y luego se cierra el socket.
  setTimeout(() => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000, 'call ended');
  }, 400);
}

// -----------------------------------------------------------------------------
// Modo respaldo por texto
// -----------------------------------------------------------------------------

function sendFallbackText(event) {
  event.preventDefault();
  const text = dom.textInput.value.trim();
  if (!text) return;
  if (!sendJson({ type: 'text', text, at: Date.now() })) {
    toast('No hay conexion: el texto no se envio', 'error');
    return;
  }
  dom.textInput.value = '';

  // Se pinta local y se recuerda por si el servidor lo ecoa como transcript.
  state.lastLocalText = normalizeText(text);
  state.lastLocalTextAt = Date.now();
  livePartials.patient = null;
  const entry = createBubble('patient');
  entry.body.textContent = text;
  entry.wrapper.classList.add('is-typed');
  state.turns += 1;
  dom.turnCount.textContent = `${state.turns} ${state.turns === 1 ? 'turno' : 'turnos'}`;
  scrollTranscriptToBottom();

  // Mismo cronometro que un turno de voz: el modo texto tambien se mide.
  markLatencyStart();
}

// -----------------------------------------------------------------------------
// Eventos
// -----------------------------------------------------------------------------

function wireEvents() {
  dom.startBtn.addEventListener('click', () => {
    startCall().catch((err) => {
      console.error('[llamada] fallo al iniciar', err);
      toast('No se pudo iniciar la llamada', 'error');
    });
  });

  dom.endBtn.addEventListener('click', endCall);
  dom.textForm.addEventListener('submit', sendFallbackText);

  // --- Push-to-talk con puntero ---
  dom.pttBtn.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    startTalking();
  });
  // El pointerup se escucha en la ventana: soltar fuera del boton tambien corta.
  window.addEventListener('pointerup', () => stopTalking());
  window.addEventListener('pointercancel', () => stopTalking());
  dom.pttBtn.addEventListener('contextmenu', (event) => event.preventDefault());
  // El boton no debe activarse con teclado: de eso se encarga el handler global.
  dom.pttBtn.addEventListener('keydown', (event) => {
    if (event.code === 'Space' || event.code === 'Enter') event.preventDefault();
  });

  // --- Push-to-talk con barra espaciadora ---
  const typingInField = (target) =>
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

  window.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || event.repeat) return;
    if (typingInField(event.target)) return;
    event.preventDefault();
    startTalking();
  });

  window.addEventListener('keyup', (event) => {
    if (event.code !== 'Space') return;
    if (typingInField(event.target)) return;
    event.preventDefault();
    stopTalking();
  });

  // Si la ventana pierde el foco con el PTT presionado, no se queda pegado.
  window.addEventListener('blur', () => stopTalking());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopTalking();
  });

  // Colgar limpio al cerrar la pestana: el servidor escribe el episodio.
  window.addEventListener('beforeunload', () => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      sendJson({ type: 'end', at: Date.now() });
      socket.close(1000, 'page unload');
    }
    teardownMicrophone();
  });
}

// -----------------------------------------------------------------------------
// Arranque
// -----------------------------------------------------------------------------

function boot() {
  buildLevelMeter();
  dom.patientMeta.textContent = patientId;
  setConnection('offline', 'Desconectado');
  setAgentState('idle');
  refreshControls();
  wireEvents();

  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    toast('Sin HTTPS el navegador bloquea el microfono. Abre la pagina en localhost.', 'warn');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Este navegador no expone getUserMedia. Solo estara disponible el modo texto.', 'warn');
  }

  /**
   * Superficie de diagnostico, solo para la consola durante la integracion.
   * Nada de la UI depende de esto. Util para el agente de Integracion:
   *   loopVoiceDebug.audioTrace()  -> gaps entre chunks de TTS (deben ser 0)
   *   loopVoiceDebug.state         -> estado interno de la llamada
   */
  window.loopVoiceDebug = {
    state,
    patientId,
    audioTrace: () => agentAudio.trace.slice(),
    audioPending: () => agentAudio.pending,
    sampleRate: () => (audioContext ? audioContext.sampleRate : null),
  };
}

boot();
