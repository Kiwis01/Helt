/**
 * Tests de la capa de audio. SIN RED: los dos proveedores de TTS estan
 * mockeados y el STT se prueba por sus piezas puras (parser + ensamblador de
 * turnos + construccion de URL), nunca abriendo un socket.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Los mocks se declaran antes de importar `tts.js` (vitest los iza igual).
vi.mock('../deepgramTts.js', () => ({ speakWithDeepgram: vi.fn() }));
vi.mock('../pollyTts.js', () => ({
  speakWithPolly: vi.fn(),
  hasPollyCredentials: vi.fn(() => true),
  resetPollyClient: vi.fn(),
}));

import { speakWithDeepgram } from '../deepgramTts.js';
import { speakWithPolly } from '../pollyTts.js';
import { findChunkEnd, splitIntoSpeakableChunks } from '../sentenceSplitter.js';
import {
  buildListenUrl,
  createTurnAssembler,
  parseDeepgramMessage,
  STT_SAMPLE_RATE,
  type DeepgramMessage,
} from '../stt.js';
import { clearTtsCache, synthesize, ttsCacheSize } from '../tts.js';

const mockDeepgram = vi.mocked(speakWithDeepgram);
const mockPolly = vi.mocked(speakWithPolly);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function* fromDeltas(deltas: readonly string[]): AsyncIterable<string> {
  for (const delta of deltas) yield delta;
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

/** Recolector de handlers del ensamblador de turnos. */
function spyHandlers() {
  const partials: string[] = [];
  const finals: string[] = [];
  const errors: Error[] = [];
  return {
    partials,
    finals,
    errors,
    handlers: {
      onPartial: (text: string) => void partials.push(text),
      onFinal: (text: string) => void finals.push(text),
      onError: (err: Error) => void errors.push(err),
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mockDeepgram.mockReset();
  mockPolly.mockReset();
  clearTtsCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// =============================================================================
// sentenceSplitter — la palanca de latencia
// =============================================================================

describe('splitIntoSpeakableChunks', () => {
  it('emite en cuanto se cierra una frase con punto', async () => {
    const chunks = await collect(
      splitIntoSpeakableChunks(fromDeltas(['Tu ritmo esta en 118.', ' Tu baseline es 68.'])),
    );
    expect(chunks).toEqual(['Tu ritmo esta en 118.', 'Tu baseline es 68.']);
  });

  it('corta en interrogacion y exclamacion, respetando los signos de apertura', async () => {
    const chunks = await collect(
      splitIntoSpeakableChunks(fromDeltas(['¿Lo hacemos juntos? Claro que si. ¡Vamos!'])),
    );
    expect(chunks).toEqual(['¿Lo hacemos juntos?', 'Claro que si.', '¡Vamos!']);
  });

  it('reensambla deltas partidos a mitad de palabra', async () => {
    const chunks = await collect(
      splitIntoSpeakableChunks(fromDeltas(['Va', 'mos a hacer', 'lo juntos. In', 'hala cuatro tiempos.'])),
    );
    expect(chunks).toEqual(['Vamos a hacerlo juntos.', 'Inhala cuatro tiempos.']);
  });

  it('no parte los decimales de una biometrica', async () => {
    const chunks = await collect(
      splitIntoSpeakableChunks(fromDeltas(['Tu HRV bajo a 21.5 milisegundos hoy.'])),
    );
    expect(chunks).toEqual(['Tu HRV bajo a 21.5 milisegundos hoy.']);
  });

  it('no corta en abreviaturas como "Dr."', async () => {
    const chunks = await collect(
      splitIntoSpeakableChunks(fromDeltas(['Tu plan lo escribio la Dr. Maya Chen el mes pasado.'])),
    );
    expect(chunks).toEqual(['Tu plan lo escribio la Dr. Maya Chen el mes pasado.']);
  });

  it('trata el salto de linea como cierre de frase', async () => {
    const chunks = await collect(splitIntoSpeakableChunks(fromDeltas(['Paso uno\nPaso dos.'])));
    expect(chunks).toEqual(['Paso uno', 'Paso dos.']);
  });

  it('corta en una coma cuando la frase larga supera maxChars', async () => {
    const largo =
      'Estoy viendo que tu frecuencia cardiaca subio bastante en la ultima media hora, ' +
      'y tu variabilidad bajo al mismo tiempo, asi que vamos a empezar por la respiracion';
    const chunks = await collect(splitIntoSpeakableChunks(fromDeltas([largo]), { maxChars: 120 }));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.endsWith(',')).toBe(true);
    expect(chunks.join(' ')).toBe(largo);
  });

  it('corta por palabra cuando no hay ni un signo de puntuacion (frase larga sin puntos)', async () => {
    const sinSignos = Array.from({ length: 60 }, (_, i) => `palabra${i}`).join(' ');
    const chunks = await collect(
      splitIntoSpeakableChunks(fromDeltas([sinSignos]), { maxChars: 120, hardMaxChars: 240 }),
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.length).toBeLessThanOrEqual(240);
    expect(chunks.join(' ')).toBe(sinSignos);
  });

  it('hace flush del residuo final aunque no termine en puntuacion', async () => {
    const chunks = await collect(
      splitIntoSpeakableChunks(fromDeltas(['Listo. Sigo aqui contigo'])),
    );
    expect(chunks).toEqual(['Listo.', 'Sigo aqui contigo']);
  });

  it('ignora deltas vacios y no emite fragmentos sin contenido locutable', async () => {
    const chunks = await collect(splitIntoSpeakableChunks(fromDeltas(['', 'Espera.', '..', '  ', 'Ya.'])));
    expect(chunks).toEqual(['Espera.', '.. Ya.']);
  });

  it('no emite nada cuando el stream viene vacio', async () => {
    expect(await collect(splitIntoSpeakableChunks(fromDeltas([])))).toEqual([]);
    expect(await collect(splitIntoSpeakableChunks(fromDeltas(['   '])))).toEqual([]);
  });

  it('findChunkEnd devuelve -1 mientras la frase sigue abierta', () => {
    expect(findChunkEnd('Estoy viendo tus datos')).toBe(-1);
    expect(findChunkEnd('Estoy viendo tus datos.')).toBe(23);
  });
});

// =============================================================================
// parseDeepgramMessage — payloads reales de Deepgram Listen
// =============================================================================

describe('parseDeepgramMessage', () => {
  const interim = JSON.stringify({
    type: 'Results',
    channel_index: [0, 1],
    duration: 1.02,
    start: 0.0,
    is_final: false,
    speech_final: false,
    channel: {
      alternatives: [{ transcript: 'me duele el', confidence: 0.94, words: [] }],
    },
    metadata: { request_id: '3f9c1b2e-0000-4000-8000-000000000000', model_info: {} },
    from_finalize: false,
  });

  const finalSpeechFinal = JSON.stringify({
    type: 'Results',
    channel_index: [0, 1],
    duration: 2.41,
    start: 1.02,
    is_final: true,
    speech_final: true,
    channel: {
      alternatives: [
        { transcript: 'me duele el pecho y se me va al brazo.', confidence: 0.99, words: [] },
      ],
    },
    metadata: { request_id: '3f9c1b2e-0000-4000-8000-000000000000' },
    from_finalize: false,
  });

  const finalNotSpeechFinal = JSON.stringify({
    type: 'Results',
    is_final: true,
    speech_final: false,
    channel: { alternatives: [{ transcript: 'me duele el pecho', confidence: 0.98 }] },
  });

  const utteranceEnd = JSON.stringify({
    type: 'UtteranceEnd',
    channel: [0, 1],
    last_word_end: 2.395,
  });

  const metadata = JSON.stringify({
    type: 'Metadata',
    transaction_key: 'deprecated',
    request_id: '3f9c1b2e-0000-4000-8000-000000000000',
    sha256: 'abc',
    created: '2026-08-01T18:20:02.000Z',
    duration: 12.4,
    channels: 1,
    models: ['nova-3'],
  });

  it('clasifica un Results interino como parcial', () => {
    expect(parseDeepgramMessage(interim)).toEqual<DeepgramMessage>({
      kind: 'partial',
      text: 'me duele el',
      speechFinal: false,
      detail: null,
    });
  });

  it('clasifica un Results final con speech_final como final cerrado', () => {
    expect(parseDeepgramMessage(finalSpeechFinal)).toEqual<DeepgramMessage>({
      kind: 'final',
      text: 'me duele el pecho y se me va al brazo.',
      speechFinal: true,
      detail: null,
    });
  });

  it('marca is_final sin speech_final como final abierto (el turno sigue)', () => {
    const parsed = parseDeepgramMessage(finalNotSpeechFinal);
    expect(parsed.kind).toBe('final');
    expect(parsed.speechFinal).toBe(false);
  });

  it('reconoce UtteranceEnd y Metadata', () => {
    expect(parseDeepgramMessage(utteranceEnd).kind).toBe('utterance-end');
    expect(parseDeepgramMessage(metadata).kind).toBe('metadata');
  });

  it('extrae la descripcion de un frame Error', () => {
    const parsed = parseDeepgramMessage(
      JSON.stringify({ type: 'Error', description: 'invalid query parameter' }),
    );
    expect(parsed.kind).toBe('error');
    expect(parsed.detail).toBe('invalid query parameter');
  });

  it('acepta Buffer ademas de string', () => {
    expect(parseDeepgramMessage(Buffer.from(interim, 'utf8')).kind).toBe('partial');
  });

  it('nunca lanza con basura: JSON invalido, tipos raros o payload desconocido', () => {
    expect(parseDeepgramMessage('esto no es json').kind).toBe('ignore');
    expect(parseDeepgramMessage('[1,2,3]').kind).toBe('ignore');
    expect(parseDeepgramMessage('null').kind).toBe('ignore');
    expect(parseDeepgramMessage(JSON.stringify({ type: 'SomethingNew' })).kind).toBe('ignore');
    expect(parseDeepgramMessage(42).kind).toBe('ignore');
  });

  it('devuelve texto vacio cuando el frame no trae alternativas', () => {
    const parsed = parseDeepgramMessage(
      JSON.stringify({ type: 'Results', is_final: false, channel: { alternatives: [] } }),
    );
    expect(parsed).toMatchObject({ kind: 'partial', text: '' });
  });
});

// =============================================================================
// Ensamblador de turnos — el motor de red-flags necesita la frase ENTERA
// =============================================================================

describe('createTurnAssembler', () => {
  const partial = (text: string): DeepgramMessage => ({
    kind: 'partial',
    text,
    speechFinal: false,
    detail: null,
  });
  const final = (text: string, speechFinal: boolean): DeepgramMessage => ({
    kind: 'final',
    text,
    speechFinal,
    detail: null,
  });

  it('acumula finales parciales y entrega el turno completo al cerrar con speech_final', () => {
    const { handlers, finals } = spyHandlers();
    const assembler = createTurnAssembler(handlers);

    assembler.accept(final('me duele el pecho', false));
    expect(finals).toEqual([]); // fragmento suelto: RF-01 NO debe verlo asi

    assembler.accept(final('y se me va al brazo.', true));
    expect(finals).toEqual(['me duele el pecho y se me va al brazo.']);
    expect(assembler.pending).toBe('');
  });

  it('cierra el turno con UtteranceEnd cuando Deepgram no manda speech_final', () => {
    const { handlers, finals } = spyHandlers();
    const assembler = createTurnAssembler(handlers);

    assembler.accept(final('no puedo respirar bien', false));
    assembler.accept({ kind: 'utterance-end', text: '', speechFinal: true, detail: null });

    expect(finals).toEqual(['no puedo respirar bien']);
  });

  it('los parciales reportan el turno en curso completo, no el fragmento suelto', () => {
    const { handlers, partials } = spyHandlers();
    const assembler = createTurnAssembler(handlers);

    assembler.accept(final('me duele el pecho', false));
    assembler.accept(partial('y se me'));

    expect(partials).toEqual(['me duele el pecho y se me']);
  });

  it('no emite turnos vacios ni reacciona a metadata', () => {
    const { handlers, finals, partials } = spyHandlers();
    const assembler = createTurnAssembler(handlers);

    assembler.accept({ kind: 'metadata', text: '', speechFinal: false, detail: null });
    assembler.accept(partial(''));
    assembler.accept({ kind: 'utterance-end', text: '', speechFinal: true, detail: null });
    assembler.flush();

    expect(finals).toEqual([]);
    expect(partials).toEqual([]);
  });

  it('propaga los frames Error por onError', () => {
    const { handlers, errors } = spyHandlers();
    createTurnAssembler(handlers).accept({
      kind: 'error',
      text: '',
      speechFinal: false,
      detail: 'boom',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('boom');
  });
});

// =============================================================================
// URL de Deepgram Listen
// =============================================================================

describe('buildListenUrl', () => {
  it('lleva los parametros exigidos por el brief', () => {
    const url = new URL(buildListenUrl());
    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('api.deepgram.com');
    expect(url.pathname).toBe('/v1/listen');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('language')).toBe('multi');
    expect(url.searchParams.get('encoding')).toBe('linear16');
    expect(url.searchParams.get('sample_rate')).toBe(String(STT_SAMPLE_RATE));
    expect(url.searchParams.get('channels')).toBe('1');
    expect(url.searchParams.get('smart_format')).toBe('true');
    expect(url.searchParams.get('interim_results')).toBe('true');
    expect(url.searchParams.get('endpointing')).toBe('300');
    expect(url.searchParams.get('utterance_end_ms')).toBe('1000');
    expect(url.searchParams.get('punctuate')).toBe('true');
    expect(url.searchParams.get('redact')).toBe('pii');
  });

  it('permite desactivar redact para el reintento de compatibilidad', () => {
    const url = new URL(buildListenUrl({ redact: null }));
    expect(url.searchParams.has('redact')).toBe(false);
  });
});

// =============================================================================
// synthesize — fallback y cache
// =============================================================================

describe('synthesize', () => {
  const dgAudio = { audio: Buffer.from('DEEPGRAM-WAV'), contentType: 'audio/wav' };
  const pollyAudio = { audio: Buffer.from('POLLY-MP3'), contentType: 'audio/mpeg' };

  it('usa Deepgram cuando responde bien y reporta provider y latencia reales', async () => {
    mockDeepgram.mockResolvedValue(dgAudio);

    const result = await synthesize('Inhala cuatro tiempos conmigo.');

    expect(result.provider).toBe('deepgram');
    expect(result.contentType).toBe('audio/wav');
    expect(result.audio.toString()).toBe('DEEPGRAM-WAV');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mockPolly).not.toHaveBeenCalled();
  });

  it('cae a Polly cuando Deepgram lanza', async () => {
    mockDeepgram.mockRejectedValue(new Error('deepgram-tts: HTTP 503'));
    mockPolly.mockResolvedValue(pollyAudio);

    const result = await synthesize('Por favor cuelga y llama al 911 ahora.');

    expect(result.provider).toBe('polly');
    expect(result.contentType).toBe('audio/mpeg');
    expect(mockDeepgram).toHaveBeenCalledTimes(1);
    expect(mockPolly).toHaveBeenCalledTimes(1);
  });

  it('cae a Polly cuando Deepgram devuelve un buffer vacio', async () => {
    mockDeepgram.mockResolvedValue({ audio: Buffer.alloc(0), contentType: 'audio/wav' });
    mockPolly.mockResolvedValue(pollyAudio);

    const result = await synthesize('Sigo aqui contigo.');

    expect(result.provider).toBe('polly');
  });

  it('cae a Polly cuando Deepgram se cuelga mas alla del timeout', async () => {
    vi.useFakeTimers();
    mockDeepgram.mockImplementation(() => new Promise<never>(() => undefined));
    mockPolly.mockResolvedValue(pollyAudio);

    const pending = synthesize('Deepgram colgado.');
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    expect(result.provider).toBe('polly');
  });

  it('devuelve provider "none" y NO lanza cuando fallan los dos proveedores', async () => {
    mockDeepgram.mockRejectedValue(new Error('sin DEEPGRAM_API_KEY'));
    mockPolly.mockRejectedValue(new Error('sin credenciales AWS'));

    const result = await synthesize('Vamos a respirar juntos.');

    expect(result.provider).toBe('none');
    expect(result.audio.length).toBe(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('no cachea los fallos: reintenta en la siguiente llamada', async () => {
    mockDeepgram.mockRejectedValueOnce(new Error('caida temporal'));
    mockPolly.mockRejectedValueOnce(new Error('caida temporal'));
    expect((await synthesize('Reintentable.')).provider).toBe('none');
    expect(ttsCacheSize()).toBe(0);

    mockDeepgram.mockResolvedValue(dgAudio);
    expect((await synthesize('Reintentable.')).provider).toBe('deepgram');
  });

  it('la cache devuelve el mismo buffer sin volver a llamar al proveedor', async () => {
    mockDeepgram.mockResolvedValue(dgAudio);
    const guion =
      'Lo que me estas describiendo necesita atencion medica inmediata. Por favor cuelga y llama al 911 ahora.';

    const first = await synthesize(guion);
    const second = await synthesize(guion);

    expect(mockDeepgram).toHaveBeenCalledTimes(1);
    expect(second.audio).toBe(first.audio); // misma referencia, cero copias
    expect(second.provider).toBe('deepgram');
    expect(ttsCacheSize()).toBe(1);
  });

  it('la cache es LRU y no pasa de 30 entradas', async () => {
    mockDeepgram.mockResolvedValue(dgAudio);
    for (let i = 0; i < 35; i++) await synthesize(`frase numero ${i}`);
    expect(ttsCacheSize()).toBe(30);
  });

  it('texto vacio no llama a ningun proveedor', async () => {
    const result = await synthesize('   ');

    expect(result.provider).toBe('none');
    expect(result.audio.length).toBe(0);
    expect(mockDeepgram).not.toHaveBeenCalled();
    expect(mockPolly).not.toHaveBeenCalled();
  });
});
