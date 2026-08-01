/**
 * Llamadas de ejemplo para el modo replay del panel en vivo.
 *
 * Por qué existe este archivo: loop-voice (:3002) todavía no está construido, y
 * aunque lo estuviera, el panel de llamada en vivo solo se puede ver mientras
 * alguien habla por un micrófono. Sin un replay local no hay forma de
 * desarrollarlo, ni de ensayar el guion visual, ni de seguir con el demo si el
 * micrófono falla en el escenario. Es la red de seguridad del bloque de 0:10 a
 * 2:00 del pitch.
 *
 * El guion feliz reproduce LITERALMENTE el transcript de
 * `shared/fixtures/episode.sample.json` (mismo texto, mismo orden, mismo
 * copago), con la biometría interpolada entre el arranque del episodio y su
 * `biometricsSnapshot`. Los tiempos sí se comprimen: la llamada real dura 14:48
 * y aquí cabe en ~72 s, que es lo que dura ese bloque del pitch.
 *
 * El guion de red-flag NO sale del fixture —`episode.sample.json` es el camino
 * feliz y su escalación es `triggered: false`— y por eso está escrito aquí como
 * lo que es: material de ensayo para poder probar el badge de escalación tres
 * veces antes del demo, con el ID de regla que emite loop-voice. Es la única
 * parte inventada del archivo y el panel avisa en pantalla cuando reproduce.
 *
 * `at` NO se escribe en el guion: se pone en el momento de reproducir, para que
 * las horas de las burbujas sean las de ahora y no las de julio de 2026.
 */

import type {
  BiometricsTickEvent,
  CallEndedEvent,
  CallStartedEvent,
  CoverageCheckEvent,
  EpisodeWrittenEvent,
  SafetyEscalationEvent,
  TranscriptTurnEvent,
} from '@loop/shared/contracts';
import { LOOP_PATIENT_ID } from '@loop/shared/constants';

/**
 * Un paso del guion. La unión discriminada es la que garantiza en tiempo de
 * compilación que cada payload corresponde a su nombre de evento; el `at` lo
 * añade el reproductor y después todo pasa por `parseLiveEnvelope`.
 */
export type DemoStep =
  | { atMs: number; event: 'call.started'; data: Omit<CallStartedEvent, 'at'> }
  | { atMs: number; event: 'transcript.turn'; data: Omit<TranscriptTurnEvent, 'at'> }
  | { atMs: number; event: 'biometrics.tick'; data: Omit<BiometricsTickEvent, 'at'> }
  | { atMs: number; event: 'safety.escalation'; data: Omit<SafetyEscalationEvent, 'at'> }
  | { atMs: number; event: 'coverage.check'; data: Omit<CoverageCheckEvent, 'at'> }
  | { atMs: number; event: 'call.ended'; data: Omit<CallEndedEvent, 'at'> }
  | { atMs: number; event: 'episode.written'; data: Omit<EpisodeWrittenEvent, 'at'> };

export type DemoCallId = 'happy' | 'redflag';

export interface DemoCall {
  id: DemoCallId;
  /** Texto del botón. Corto: la cabecera del panel mide 24rem. */
  label: string;
  description: string;
  steps: readonly DemoStep[];
}

/** Sobre listo para `parseLiveEnvelope`. Devuelve `unknown` a propósito: el reproductor lo valida. */
export function demoStepEnvelope(step: DemoStep, at: string): unknown {
  return { event: step.event, data: { ...step.data, at } };
}

export function demoCallDurationMs(call: DemoCall): number {
  return call.steps.reduce((max, step) => Math.max(max, step.atMs), 0);
}

/* ================================================================== */
/* Guion 1 — camino feliz (transcript literal de episode.sample.json)  */
/* ================================================================== */

const HAPPY_CALL_ID = 'call-8f2a';

const HAPPY_STEPS: readonly DemoStep[] = [
  {
    atMs: 0,
    event: 'call.started',
    data: { callId: HAPPY_CALL_ID, patientId: LOOP_PATIENT_ID },
  },
  {
    atMs: 400,
    event: 'biometrics.tick',
    data: { callId: HAPPY_CALL_ID, heartRate: 118, hrv: 21, respiratoryRate: 24 },
  },
  {
    atMs: 900,
    event: 'transcript.turn',
    data: {
      callId: HAPPY_CALL_ID,
      speaker: 'system',
      text: 'Esta llamada no sustituye la atención de emergencia. Si crees que es una emergencia, cuelga y llama al 911.',
    },
  },
  {
    atMs: 3_400,
    event: 'transcript.turn',
    data: {
      callId: HAPPY_CALL_ID,
      speaker: 'patient',
      text: 'Me está costando respirar y siento el corazón muy acelerado, creo que está pasando otra vez.',
    },
  },
  {
    atMs: 5_000,
    event: 'biometrics.tick',
    data: { callId: HAPPY_CALL_ID, heartRate: 122, hrv: 20, respiratoryRate: 25 },
  },
  {
    atMs: 6_800,
    event: 'transcript.turn',
    data: {
      callId: HAPPY_CALL_ID,
      speaker: 'agent',
      text: 'Estoy contigo. Tu frecuencia cardiaca está en 118 y tu promedio de los últimos 30 días es 68. Tu variabilidad también bajó. Esto se parece a los últimos cuatro episodios que registraste.',
    },
  },
  // Pico de la llamada. Coincide con `biometricsSnapshot` del fixture.
  {
    atMs: 10_500,
    event: 'biometrics.tick',
    data: { callId: HAPPY_CALL_ID, heartRate: 126, hrv: 18, respiratoryRate: 27 },
  },
  {
    atMs: 13_000,
    event: 'transcript.turn',
    data: {
      callId: HAPPY_CALL_ID,
      speaker: 'agent',
      text: 'Tu plan de cuidado, el que escribió la doctora Chen, dice empezar con respiración de caja. ¿Lo hacemos juntos?',
    },
  },
  {
    atMs: 16_500,
    event: 'transcript.turn',
    data: { callId: HAPPY_CALL_ID, speaker: 'patient', text: 'Sí, está bien.' },
  },
  {
    atMs: 18_000,
    event: 'biometrics.tick',
    data: { callId: HAPPY_CALL_ID, heartRate: 124, hrv: 19, respiratoryRate: 26 },
  },
  {
    atMs: 21_000,
    event: 'transcript.turn',
    data: {
      callId: HAPPY_CALL_ID,
      speaker: 'agent',
      text: 'Inhala conmigo durante cuatro tiempos. Sostén cuatro. Exhala cuatro. Sostén cuatro. No tienes que hablar.',
    },
  },
  {
    atMs: 26_000,
    event: 'biometrics.tick',
    data: { callId: HAPPY_CALL_ID, heartRate: 116, hrv: 22, respiratoryRate: 24 },
  },
  {
    atMs: 32_000,
    event: 'biometrics.tick',
    data: { callId: HAPPY_CALL_ID, heartRate: 108, hrv: 25, respiratoryRate: 22 },
  },
  {
    atMs: 38_000,
    event: 'biometrics.tick',
    data: { callId: HAPPY_CALL_ID, heartRate: 101, hrv: 28, respiratoryRate: 20 },
  },
  {
    atMs: 41_000,
    event: 'transcript.turn',
    data: { callId: HAPPY_CALL_ID, speaker: 'patient', text: 'Ya respiro mejor. Como un seis de diez.' },
  },
  {
    atMs: 44_000,
    event: 'biometrics.tick',
    data: { callId: HAPPY_CALL_ID, heartRate: 96, hrv: 30, respiratoryRate: 19 },
  },
  {
    atMs: 46_000,
    event: 'transcript.turn',
    data: {
      callId: HAPPY_CALL_ID,
      speaker: 'agent',
      text: 'Tu frecuencia bajó a 94 desde que empezamos. Tu plan también menciona agendar una sesión con tu equipo de cuidado. Déjame revisar tu cobertura.',
    },
  },
  // El coverage check llega ANTES de que el agente lo lea en voz alta: es el
  // orden real, y es lo que hace que la tarjeta de cobertura se rellene justo
  // un segundo antes de que el público oiga el copago.
  {
    atMs: 50_000,
    event: 'coverage.check',
    data: {
      callId: HAPPY_CALL_ID,
      checkId: 'cov-1a2b3c',
      status: 'covered',
      copayCents: 2500,
      deductibleRemainingCents: 8000,
      payerName: 'Test Payer Inc',
      voiceSummary:
        'Tu sesión de telesalud sí está cubierta. Tu copago es de 25 dólares, y te quedan 80 dólares por cubrir de tu deducible.',
    },
  },
  {
    atMs: 52_000,
    event: 'transcript.turn',
    data: {
      callId: HAPPY_CALL_ID,
      speaker: 'agent',
      text: 'Tu sesión de telesalud sí está cubierta. Tu copago es de 25 dólares, y te quedan 80 dólares por cubrir de tu deducible.',
    },
  },
  {
    atMs: 56_000,
    event: 'biometrics.tick',
    data: { callId: HAPPY_CALL_ID, heartRate: 94, hrv: 32, respiratoryRate: 18 },
  },
  {
    atMs: 60_000,
    event: 'transcript.turn',
    data: { callId: HAPPY_CALL_ID, speaker: 'patient', text: 'Gracias. Creo que ya estoy mejor.' },
  },
  {
    atMs: 63_000,
    event: 'biometrics.tick',
    data: { callId: HAPPY_CALL_ID, heartRate: 88, hrv: 36, respiratoryRate: 16 },
  },
  {
    atMs: 66_000,
    event: 'call.ended',
    // 18:20:02 → 18:34:50 en el fixture: 888 s.
    data: { callId: HAPPY_CALL_ID, outcome: 'resolved-with-intervention', durationSeconds: 888 },
  },
  {
    atMs: 70_000,
    event: 'episode.written',
    data: { callId: HAPPY_CALL_ID, encounterId: 'enc-0042' },
  },
];

/* ================================================================== */
/* Guion 2 — red-flag (material de ensayo, no sale de ningún fixture)  */
/* ================================================================== */

const REDFLAG_CALL_ID = 'call-9c31';

const REDFLAG_STEPS: readonly DemoStep[] = [
  {
    atMs: 0,
    event: 'call.started',
    data: { callId: REDFLAG_CALL_ID, patientId: LOOP_PATIENT_ID },
  },
  {
    atMs: 400,
    event: 'biometrics.tick',
    data: { callId: REDFLAG_CALL_ID, heartRate: 132, hrv: 16, respiratoryRate: 28 },
  },
  {
    atMs: 1_500,
    event: 'transcript.turn',
    data: {
      callId: REDFLAG_CALL_ID,
      speaker: 'system',
      text: 'Esta llamada no sustituye la atención de emergencia. Si crees que es una emergencia, cuelga y llama al 911.',
    },
  },
  {
    atMs: 4_000,
    event: 'transcript.turn',
    data: {
      callId: REDFLAG_CALL_ID,
      speaker: 'patient',
      text: 'Me duele el pecho y el dolor se me está yendo al brazo izquierdo.',
    },
  },
  {
    atMs: 6_000,
    event: 'biometrics.tick',
    data: { callId: REDFLAG_CALL_ID, heartRate: 151, hrv: 14, respiratoryRate: 31 },
  },
  // La regla dispara ANTES del siguiente turno del agente: ese orden es el
  // argumento del bloque de seguridad —la escalación no es la salida del
  // modelo, es un umbral evaluado antes de invocarlo.
  {
    atMs: 7_200,
    event: 'safety.escalation',
    data: { callId: REDFLAG_CALL_ID, rule: 'RF-01-CHEST-PAIN-RADIATING', action: 'advise-911' },
  },
  {
    atMs: 9_000,
    event: 'transcript.turn',
    data: {
      callId: REDFLAG_CALL_ID,
      speaker: 'agent',
      text: 'Voy a parar aquí. Lo que describes puede ser una emergencia médica y no es algo que yo pueda evaluar. Cuelga y llama al 911 ahora mismo.',
    },
  },
  {
    atMs: 12_500,
    event: 'transcript.turn',
    data: { callId: REDFLAG_CALL_ID, speaker: 'patient', text: 'Ok, voy a llamar.' },
  },
  {
    atMs: 14_000,
    event: 'biometrics.tick',
    data: { callId: REDFLAG_CALL_ID, heartRate: 148, hrv: 15, respiratoryRate: 30 },
  },
  {
    atMs: 18_000,
    event: 'transcript.turn',
    data: {
      callId: REDFLAG_CALL_ID,
      speaker: 'agent',
      text: 'Me quedo contigo hasta que hables con ellos. No estás solo.',
    },
  },
  {
    atMs: 22_000,
    event: 'biometrics.tick',
    data: { callId: REDFLAG_CALL_ID, heartRate: 143, hrv: 16, respiratoryRate: 29 },
  },
  {
    atMs: 26_000,
    event: 'call.ended',
    data: { callId: REDFLAG_CALL_ID, outcome: 'escalated-emergency', durationSeconds: 168 },
  },
  {
    atMs: 30_000,
    event: 'episode.written',
    data: { callId: REDFLAG_CALL_ID, encounterId: 'enc-0043' },
  },
];

/* ================================================================== */

export const DEMO_CALLS: Record<DemoCallId, DemoCall> = {
  happy: {
    id: 'happy',
    label: 'Replay',
    description: 'Llamada de ejemplo: episodio resuelto con respiración de caja y coverage check.',
    steps: HAPPY_STEPS,
  },
  redflag: {
    id: 'redflag',
    label: 'Red-flag',
    description: 'Llamada de ensayo: dolor torácico irradiado, escalación determinista RF-01.',
    steps: REDFLAG_STEPS,
  },
};

export const DEMO_CALL_IDS: readonly DemoCallId[] = ['happy', 'redflag'];
