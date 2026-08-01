/**
 * El motor de red-flags.
 *
 * =============================================================================
 *  FUNCION PURA. Sin I/O, sin red, sin reloj, sin `process.env`, sin LLM.
 * =============================================================================
 *
 * Corre en CADA turno del paciente, ANTES de cualquier llamada al modelo. Si
 * `triggered` es true, el orquestador:
 *   1. NO invoca al LLM para ese turno
 *   2. locuta `script` tal cual (hardcodeado en `scripts.ts`)
 *   3. emite `safety.escalation` con `ruleId` y `matchedEvidence`
 *   4. termina la llamada con outcome `escalated-emergency` / `escalated-human`
 *
 * Que sea pura no es estetica: es lo que permite que los 50+ casos del test
 * suite se ejecuten en milisegundos y que un juez pueda pedir "prueba esta
 * frase" en la terminal y obtener el mismo resultado que en la llamada real.
 */

import type { CurrentBiometrics, RedFlagInput, RedFlagResult, SafetyEnvelope } from '../types.js';
import { RULES_IN_EVALUATION_ORDER, evaluateRule, normalize } from './rules.js';

/**
 * Resultado "no pasa nada". Se construye nuevo en cada llamada a proposito: si
 * fuera una constante compartida y alguien la mutara aguas abajo, el motor
 * empezaria a mentir en silencio.
 */
function noRedFlag(): RedFlagResult {
  return {
    triggered: false,
    ruleId: null,
    action: null,
    script: null,
    matchedEvidence: null,
    severity: 'none',
  };
}

/**
 * Evalua un turno del paciente contra las 9 reglas.
 *
 * Orden: RF-09 (prioridad maxima) -> RF-01..RF-07 -> RF-08. La PRIMERA que
 * dispara gana y se corta la evaluacion; no se acumulan reglas ni se puntua.
 * Una emergencia no se somete a votacion.
 *
 * `biometrics === null` (aun no llego un tick del wearable) salta RF-08 y RF-09
 * y evalua el resto con normalidad. Nunca se asume "biometria normal": la
 * ausencia de dato no es un dato tranquilizador.
 *
 * No muta `input` ni ninguno de sus campos.
 */
export function evaluate(input: RedFlagInput): RedFlagResult {
  // Frontera defensiva: el transcript viene de un STT, no de un formulario.
  const rawText = typeof input?.transcriptText === 'string' ? input.transcriptText : '';
  const normalized = normalize(rawText);

  const biometrics: CurrentBiometrics | null = input?.biometrics ?? null;
  const envelope: SafetyEnvelope | undefined = input?.safetyEnvelope;

  // Sin envelope no hay umbrales que comparar: las reglas biometricas se saltan,
  // las de texto siguen funcionando. Un care plan incompleto no puede silenciar
  // el motor entero.
  const safeEnvelope: SafetyEnvelope = envelope ?? {
    heartRateMax: Number.POSITIVE_INFINITY,
    heartRateMin: Number.NEGATIVE_INFINITY,
    respiratoryRateMax: Number.POSITIVE_INFINITY,
    spo2Min: Number.NEGATIVE_INFINITY,
  };

  for (const rule of RULES_IN_EVALUATION_ORDER) {
    const evidence = evaluateRule(rule, normalized, biometrics, safeEnvelope);
    if (evidence === null) continue;

    return {
      triggered: true,
      ruleId: rule.id,
      action: rule.action,
      script: rule.script,
      matchedEvidence: evidence,
      severity: rule.severity,
    };
  }

  return noRedFlag();
}
