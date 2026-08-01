/**
 * =============================================================================
 *  loop-voice · AudioWorkletProcessor de captura
 *  Archivo: voice/public/audio-worklet.js   (Agente G)
 * =============================================================================
 *
 * Convierte el audio del microfono a PCM linear16 mono @ 16 kHz, que es lo que
 * el servidor reenvia a Deepgram Listen (nova-3, language=multi).
 *
 * Por que un AudioWorklet y no un ScriptProcessorNode:
 *   - ScriptProcessorNode esta deprecado y corre en el hilo principal, asi que
 *     cualquier repintado del DOM (y esta UI repinta el transcript en vivo)
 *     mete glitches y muestras perdidas en el audio.
 *   - El worklet corre en el hilo de audio en tiempo real: el resampleo nunca
 *     compite con el render.
 *
 * Contrato con el hilo principal (app.js)
 * ---------------------------------------
 * processorOptions (al construir el AudioWorkletNode):
 *   {
 *     targetSampleRate: 16000,   // frecuencia de salida
 *     chunkMs: 100               // duracion de cada buffer que se emite
 *   }
 *
 * Worklet -> main:
 *   { type: 'audio', buffer: ArrayBuffer, samples: number }
 *       PCM signed 16-bit little-endian, mono, a targetSampleRate.
 *       Se transfiere (zero-copy). Se emite mientras capture === true y una
 *       ultima vez, con el resto parcial, al recibir 'flush'.
 *   { type: 'flush-done' }
 *       Acuse del 'flush'. El main thread manda el {"type":"stop"} al recibirlo.
 *   { type: 'level', rms: number }
 *       RMS lineal (0..1) del bloque, para el medidor de nivel. Se emite
 *       siempre que hay senal, este capturando o no.
 *
 * main -> Worklet:
 *   { type: 'capture', on: boolean }
 *       Abre o cierra la compuerta del push-to-talk. Al cerrarla se descarta el
 *       buffer parcial: no queremos que la cola de un turno se pegue al
 *       siguiente. El grafo de audio se queda conectado siempre para evitar
 *       clicks al reconectar el nodo.
 *   { type: 'flush' }
 *       Emite el buffer parcial pendiente (se usa al soltar el push-to-talk,
 *       antes de mandar el mensaje de stop, para no perder la ultima silaba).
 *       Responde siempre con { type: 'flush-done' }, haya o no chunk parcial.
 *
 * Nota sobre el resampleo
 * -----------------------
 * `sampleRate` en el AudioWorkletGlobalScope es la frecuencia real del
 * AudioContext (48000 casi siempre, 44100 en algunas maquinas). NO se asume:
 * se calcula la razon y se interpola linealmente, arrastrando la ultima muestra
 * del bloque anterior para que la frontera entre bloques no meta un escalon.
 */

const DEFAULT_TARGET_RATE = 16000;
const DEFAULT_CHUNK_MS = 100;

/** Cada cuantos render quanta (128 frames) se reporta el nivel. ~21 ms a 48 kHz. */
const LEVEL_EVERY_QUANTA = 8;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const opts = (options && options.processorOptions) || {};
    const targetRate = Number(opts.targetSampleRate) || DEFAULT_TARGET_RATE;
    const chunkMs = Number(opts.chunkMs) || DEFAULT_CHUNK_MS;

    /** Frecuencia de salida en Hz. */
    this.targetRate = targetRate;

    /** Cuantas muestras de entrada avanzamos por cada muestra de salida. */
    this.step = sampleRate / targetRate;

    /**
     * Posicion de lectura dentro del bloque actual, en muestras de entrada.
     * Puede quedar en [-1, 0) entre bloques: en ese caso la muestra izquierda
     * de la interpolacion es `prevSample` (la ultima del bloque anterior).
     */
    this.readPos = 0;

    /** Ultima muestra del bloque anterior, para interpolar en la frontera. */
    this.prevSample = 0;

    /** Buffer de salida acumulado hasta completar chunkMs. */
    this.chunkSamples = Math.max(160, Math.round((targetRate * chunkMs) / 1000));
    this.out = new Int16Array(this.chunkSamples);
    this.outIndex = 0;

    /** Compuerta del push-to-talk. Arranca cerrada. */
    this.capture = false;

    /** Contador de bloques para espaciar los reportes de nivel. */
    this.quantaSinceLevel = 0;

    /** Envolvente suavizada del nivel, para que el medidor no parpadee. */
    this.levelEnvelope = 0;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'capture') {
        const next = Boolean(msg.on);
        if (next === this.capture) return;
        this.capture = next;
        // Al abrir o cerrar la compuerta se descarta lo que quedaba a medias:
        // ese audio pertenece a otro turno.
        this.outIndex = 0;
        if (!next) {
          this.levelEnvelope = 0;
          this.port.postMessage({ type: 'level', rms: 0 });
        }
        return;
      }

      if (msg.type === 'flush') {
        this.emitChunk();
        // El main thread espera este acuse para mandar {"type":"stop"} DESPUES
        // del ultimo chunk: si mandara el stop antes, el servidor haria
        // Finalize en Deepgram y se perderia la ultima silaba del turno.
        this.port.postMessage({ type: 'flush-done' });
      }
    };
  }

  /** Emite lo que haya acumulado (aunque sea menos de un chunk completo). */
  emitChunk() {
    if (this.outIndex === 0) return;
    const slice = this.out.slice(0, this.outIndex);
    this.outIndex = 0;
    this.port.postMessage(
      { type: 'audio', buffer: slice.buffer, samples: slice.length },
      [slice.buffer],
    );
  }

  /**
   * @param {Float32Array[][]} inputs
   * @returns {boolean} true para seguir vivo aunque no haya entrada todavia.
   */
  process(inputs) {
    const input = inputs[0];
    const channel = input && input.length > 0 ? input[0] : null;

    // Sin microfono conectado aun (o pista silenciada): el nodo sigue vivo.
    if (!channel || channel.length === 0) return true;

    const frames = channel.length;

    // ---- Nivel (RMS) --------------------------------------------------------
    this.quantaSinceLevel += 1;
    if (this.quantaSinceLevel >= LEVEL_EVERY_QUANTA) {
      this.quantaSinceLevel = 0;
      let sumSquares = 0;
      for (let i = 0; i < frames; i += 1) sumSquares += channel[i] * channel[i];
      const rms = Math.sqrt(sumSquares / frames);
      // Ataque rapido, caida lenta: se ve como un VU de verdad.
      this.levelEnvelope = rms > this.levelEnvelope
        ? rms
        : this.levelEnvelope * 0.82 + rms * 0.18;
      this.port.postMessage({ type: 'level', rms: this.capture ? this.levelEnvelope : 0 });
    }

    if (!this.capture) {
      // Aun cerrado, mantenemos la continuidad del resampler para que el
      // primer chunk del siguiente turno no arranque con un escalon.
      this.prevSample = channel[frames - 1];
      this.readPos = 0;
      return true;
    }

    // ---- Resampleo lineal a targetRate + cuantizacion a Int16 ---------------
    let pos = this.readPos;
    const step = this.step;
    const limit = frames - 1; // se necesita la muestra derecha para interpolar

    while (pos < limit) {
      const left = Math.floor(pos);
      const frac = pos - left;
      const a = left < 0 ? this.prevSample : channel[left];
      const b = channel[left + 1];
      let sample = a + (b - a) * frac;

      // Clamp antes de escalar: un pico por encima de 1.0 no debe envolver.
      if (sample > 1) sample = 1;
      else if (sample < -1) sample = -1;

      this.out[this.outIndex] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.outIndex += 1;

      if (this.outIndex >= this.chunkSamples) this.emitChunk();

      pos += step;
    }

    // El siguiente bloque continua donde quedo este.
    this.readPos = pos - frames;
    this.prevSample = channel[frames - 1];

    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
