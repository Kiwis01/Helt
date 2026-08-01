/**
 * TTS primario: Deepgram Aura-2 (REST, sintesis de un fragmento corto).
 *
 * Se llama una vez por fragmento hablable (ver `sentenceSplitter.ts`), no una
 * vez por respuesta completa. Devuelve WAV listo para el `<audio>` del browser.
 *
 * Este modulo LANZA cuando falla. Quien decide degradar es `tts.ts`, que cae a
 * Polly. Aqui no hay logica de fallback a proposito: un solo responsable.
 */

import { config } from '../config.js';

/** Audio crudo devuelto por un proveedor de TTS. */
export interface RawAudio {
  audio: Buffer;
  contentType: string;
}

const DEEPGRAM_SPEAK_URL = 'https://api.deepgram.com/v1/speak';

/**
 * Sintetiza `text` con Aura-2.
 *
 * Parametros de la query segun el brief: `model=<DG_TTS_VOICE>`,
 * `encoding=linear16`, `sample_rate=24000`. Con `linear16` Deepgram devuelve
 * contenedor WAV por defecto, que es lo que el navegador sabe reproducir sin
 * tocar nada.
 *
 * @throws si falta la API key, si la respuesta no es 2xx, si vence
 *         `config.timeouts.ttsMs` o si el cuerpo viene vacio.
 */
export async function speakWithDeepgram(text: string, signal?: AbortSignal): Promise<RawAudio> {
  const apiKey = config.deepgram.apiKey;
  if (!apiKey) throw new Error('deepgram-tts: falta DEEPGRAM_API_KEY');

  const url = new URL(DEEPGRAM_SPEAK_URL);
  url.searchParams.set('model', config.deepgram.ttsVoice);
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('sample_rate', '24000');

  // Timeout propio + el del llamante (el orquestador aborta si el paciente
  // vuelve a hablar y la respuesta ya no sirve).
  const timeoutSignal = AbortSignal.timeout(config.timeouts.ttsMs);
  const combined = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      // La API key vive SOLO en el servidor. Nunca viaja al browser.
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'audio/*',
    },
    body: JSON.stringify({ text }),
    signal: combined,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`deepgram-tts: HTTP ${response.status} ${detail.slice(0, 200)}`);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) throw new Error('deepgram-tts: respuesta de audio vacia');

  const header = response.headers.get('content-type');
  const contentType = header && header.startsWith('audio/') ? header : 'audio/wav';

  return { audio, contentType };
}
