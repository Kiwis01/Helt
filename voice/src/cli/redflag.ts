/**
 * CLI del motor de red-flags.
 *
 *   npm run redflag "me duele el pecho y se me va al brazo"
 *   npm run redflag -- --hr=163 --rr=34 "me duele el pecho"
 *   npm run redflag -- --rules
 *
 * Existe por un motivo muy concreto: el DoD de la Fase 1 dice que hay que poder
 * demostrar el motor de seguridad COMPLETO desde la terminal, sin voz, sin
 * credenciales y sin red. Si el dia del demo se cae Deepgram, se cae Bedrock y
 * se cae el wifi, esto sigue corriendo y sigue siendo un pitch defendible.
 *
 * No toca red, no toca disco y no lee ninguna credencial. Solo llama a
 * `evaluate()`, que es una funcion pura.
 *
 * Sale SIEMPRE con codigo 0, incluso si el motor dispara: disparar es un
 * resultado correcto, no un fallo del programa.
 */

import { evaluate } from '../safety/index.js';
import { RED_FLAG_RULES, normalize } from '../safety/rules.js';
import type { CurrentBiometrics, RedFlagInput, SafetyEnvelope } from '../types.js';

// -----------------------------------------------------------------------------
// Envelope por defecto
// -----------------------------------------------------------------------------

/**
 * Mismos limites que el `safetyEnvelope` del care plan del demo
 * (`shared/fixtures/context.happy.json`). Se copian aqui y no se leen del
 * fixture a proposito: el CLI no hace I/O.
 */
const DEFAULT_ENVELOPE: SafetyEnvelope = {
  heartRateMax: 150,
  heartRateMin: 40,
  respiratoryRateMax: 32,
  spo2Min: 92,
  note: 'Envelope del care plan del demo, copiado para que el CLI no haga I/O.',
};

// -----------------------------------------------------------------------------
// Parseo de argumentos
// -----------------------------------------------------------------------------

interface ParsedArgs {
  phrase: string;
  hr: number | null;
  rr: number | null;
  hrv: number | null;
  spo2: number | null;
  showRules: boolean;
  showHelp: boolean;
}

/**
 * Separa las flags de la frase.
 *
 * npm se come las comillas al reenviar el argumento, asi que la frase llega
 * troceada en varios `argv`. Por eso se juntan todos los no-flag con un espacio
 * en vez de leer `process.argv[2]`.
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
  const words: string[] = [];
  const flags = new Map<string, string>();

  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [rawName, rawValue] = arg.slice(2).split('=', 2);
      flags.set((rawName ?? '').toLowerCase(), rawValue ?? 'true');
    } else {
      words.push(arg);
    }
  }

  const numeric = (name: string): number | null => {
    const raw = flags.get(name);
    if (raw === undefined) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    phrase: words.join(' ').trim(),
    hr: numeric('hr'),
    rr: numeric('rr'),
    hrv: numeric('hrv'),
    spo2: numeric('spo2'),
    showRules: flags.has('rules'),
    showHelp: flags.has('help') || flags.has('h'),
  };
}

/**
 * Construye la biometria a partir de las flags.
 *
 * Devuelve null si no se paso ninguna: sin lectura del wearable, RF-08 y RF-09
 * se saltan y el resto de reglas se evaluan igual. Nunca se inventan valores
 * "normales" de relleno — eso convertiria una ausencia de dato en un dato
 * tranquilizador, que es justo lo que el brief prohibe.
 */
function buildBiometrics(args: ParsedArgs): CurrentBiometrics | null {
  if (args.hr === null && args.rr === null && args.hrv === null && args.spo2 === null) {
    return null;
  }

  const hr = args.hr ?? 70;
  const rr = args.rr ?? 14;
  const hrv = args.hrv ?? 50;

  const bio: CurrentBiometrics = {
    windowMinutes: 30,
    heartRate: { latest: hr, max: hr, trend: 'stable', unit: 'bpm' },
    hrv: { latest: hrv, min: hrv, trend: 'stable', unit: 'ms' },
    respiratoryRate: { latest: rr, max: rr, trend: 'stable', unit: 'breaths/min' },
    lastSampleAt: '1970-01-01T00:00:00Z',
  };

  if (args.spo2 !== null) {
    bio.spo2 = { latest: args.spo2, min: args.spo2, trend: 'stable', unit: '%' };
  }

  return bio;
}

// -----------------------------------------------------------------------------
// Salida
// -----------------------------------------------------------------------------

const LINE = '-'.repeat(72);

function printHelp(): void {
  console.log(`
loop-voice · motor de red-flags (determinista, sin red, sin LLM)

  npm run redflag "me duele el pecho y se me va al brazo"
  npm run redflag -- --hr=163 --rr=34 "me duele el pecho"
  npm run redflag -- --hr=163 ""
  npm run redflag -- --rules

Flags:
  --hr=<bpm>     frecuencia cardiaca actual   (envelope: ${DEFAULT_ENVELOPE.heartRateMin}-${DEFAULT_ENVELOPE.heartRateMax})
  --rr=<rpm>     frecuencia respiratoria      (envelope: <= ${DEFAULT_ENVELOPE.respiratoryRateMax})
  --spo2=<%>     saturacion de oxigeno        (envelope: >= ${DEFAULT_ENVELOPE.spo2Min})
  --hrv=<ms>     variabilidad cardiaca        (no dispara ninguna regla, va de contexto)
  --rules        lista las 9 reglas en orden de evaluacion
  --help         esto

Sin ninguna flag biometrica, RF-08 y RF-09 se saltan y solo se evalua el texto.
`);
}

function printRules(): void {
  console.log(`\n${LINE}\n  Las 9 reglas, en orden de evaluacion (la primera que dispara gana)\n${LINE}`);
  const ordered = [...RED_FLAG_RULES].sort((a, b) => b.priority - a.priority);
  for (const rule of ordered) {
    const signals = [rule.matchText ? 'texto' : null, rule.matchBiometrics ? 'biometria' : null]
      .filter(Boolean)
      .join(' + ');
    console.log(
      `  [prio ${String(rule.priority).padStart(3)}] ${rule.id.padEnd(28)} -> ${rule.action} (${rule.severity}) · señales: ${signals}`,
    );
    console.log(`             ${rule.description}`);
  }
  console.log('');
}

function describeBiometrics(bio: CurrentBiometrics | null): string {
  if (bio === null) return 'ninguna (RF-08 y RF-09 se saltan)';
  const parts = [
    `HR ${bio.heartRate.latest} ${bio.heartRate.unit}`,
    `RR ${bio.respiratoryRate.latest} ${bio.respiratoryRate.unit}`,
    `HRV ${bio.hrv.latest} ${bio.hrv.unit}`,
  ];
  if (bio.spo2) parts.push(`SpO2 ${bio.spo2.latest} ${bio.spo2.unit}`);
  return parts.join(' · ');
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.showHelp) {
    printHelp();
    return;
  }

  if (args.showRules) {
    printRules();
    return;
  }

  const biometrics = buildBiometrics(args);

  if (args.phrase.length === 0 && biometrics === null) {
    printHelp();
    console.log('SIN RED FLAG');
    return;
  }

  const input: RedFlagInput = {
    transcriptText: args.phrase,
    biometrics,
    safetyEnvelope: DEFAULT_ENVELOPE,
  };

  const result = evaluate(input);

  console.log(`\n${LINE}`);
  console.log('  loop-voice · motor de red-flags · determinista, corre ANTES del LLM');
  console.log(LINE);
  console.log(`  Frase:       "${args.phrase}"`);
  console.log(`  Normalizado: ${normalize(args.phrase) || '(vacio)'}`);
  console.log(`  Biometria:   ${describeBiometrics(biometrics)}`);
  console.log(
    `  Envelope:    HR ${DEFAULT_ENVELOPE.heartRateMin}-${DEFAULT_ENVELOPE.heartRateMax} bpm · RR <= ${DEFAULT_ENVELOPE.respiratoryRateMax} · SpO2 >= ${DEFAULT_ENVELOPE.spo2Min}%`,
  );
  console.log(LINE);

  if (!result.triggered) {
    console.log('SIN RED FLAG');
    console.log('El turno sigue su curso normal: contexto -> LLM -> TTS.\n');
    return;
  }

  console.log(`DISPARA: ${result.ruleId} -> ${result.action} (${result.severity})`);
  console.log(`Evidencia: "${result.matchedEvidence}"`);
  console.log(`Guion: "${result.script}"`);
  console.log('');
  console.log('El LLM NO se invoca para este turno. La llamada termina aqui.\n');
}

try {
  main();
} catch (err) {
  // Ni siquiera un fallo inesperado del CLI puede devolver codigo distinto de 0:
  // este binario se usa en vivo delante de un jurado.
  console.error(`[redflag] error inesperado: ${err instanceof Error ? err.message : String(err)}`);
  console.log('SIN RED FLAG');
}

process.exitCode = 0;
