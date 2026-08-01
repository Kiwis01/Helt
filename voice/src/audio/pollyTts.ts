/**
 * TTS de respaldo: AWS Polly (motor `generative`, voz `Lupe`, es-US).
 *
 * Se usa cuando Deepgram falla, tarda mas de `TIMEOUT_TTS_MS` o devuelve audio
 * vacio. Comparte las credenciales AWS con Bedrock, asi que si el LLM funciona
 * este respaldo tambien funciona: no hay una tercera cuenta que se pueda caer
 * el dia del demo.
 *
 * Este modulo LANZA cuando falla. El fallback lo decide `tts.ts`.
 */

import { PollyClient, SynthesizeSpeechCommand, type VoiceId } from '@aws-sdk/client-polly';

import { config } from '../config.js';
import type { RawAudio } from './deepgramTts.js';

/** Motores validos de Polly. `POLLY_ENGINE` se valida contra esta lista. */
const VALID_ENGINES = ['standard', 'neural', 'long-form', 'generative'] as const;
type PollyEngine = (typeof VALID_ENGINES)[number];

/** Voz espanola del demo; el idioma se fija para que no lo infiera del texto. */
const LANGUAGE_CODE = 'es-US';

let client: PollyClient | null = null;

function resolveEngine(): PollyEngine {
  const raw = config.polly.engine.toLowerCase();
  const match = VALID_ENGINES.find((engine) => engine === raw);
  if (match) return match;
  console.warn(`[tts] POLLY_ENGINE="${config.polly.engine}" no es valido; se usa "generative"`);
  return 'generative';
}

/** True si hay credenciales AWS explicitas o cadena por defecto utilizable. */
export function hasPollyCredentials(): boolean {
  return Boolean(config.aws.accessKeyId && config.aws.secretAccessKey);
}

function getClient(): PollyClient {
  if (client) return client;
  const { region, accessKeyId, secretAccessKey, sessionToken } = config.aws;
  client = new PollyClient({
    region,
    // Si no hay credenciales explicitas se deja que el SDK use su cadena por
    // defecto (perfil, rol, variables de entorno del proceso).
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) } }
      : {}),
  });
  return client;
}

/**
 * Sintetiza `text` con Polly. Devuelve MP3 (`audio/mpeg`), que el navegador
 * reproduce igual de bien que el WAV de Deepgram.
 *
 * @throws si Polly rechaza la peticion o no devuelve stream de audio.
 */
export async function speakWithPolly(text: string): Promise<RawAudio> {
  const response = await getClient().send(
    new SynthesizeSpeechCommand({
      Text: text,
      // Frontera de SDK: `POLLY_VOICE` es un string de entorno y `VoiceId` es
      // una union cerrada de nombres. Si el nombre fuera invalido, Polly
      // responde con error y `tts.ts` degrada; no hace falta duplicar aqui el
      // catalogo completo de voces de AWS.
      VoiceId: config.polly.voice as VoiceId,
      Engine: resolveEngine(),
      OutputFormat: 'mp3',
      LanguageCode: LANGUAGE_CODE,
    }),
  );

  if (!response.AudioStream) throw new Error('polly-tts: respuesta sin AudioStream');

  const bytes = await response.AudioStream.transformToByteArray();
  const audio = Buffer.from(bytes);
  if (audio.length === 0) throw new Error('polly-tts: respuesta de audio vacia');

  return { audio, contentType: 'audio/mpeg' };
}

/** Solo para tests: fuerza la reconstruccion del cliente. */
export function resetPollyClient(): void {
  client = null;
}
