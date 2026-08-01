/**
 * Normalizacion tolerante del **Contrato 1** (`GET :3001/api/v1/context/:id`).
 *
 * =============================================================================
 *  POR QUE EXISTE ESTE ARCHIVO
 * =============================================================================
 * `patientContextSchema` (en `shared/contracts.ts`) exige TODOS los campos del
 * ejemplo del brief. Eso esta bien como definicion del contrato, pero es un mal
 * portero: si Kiwis manda un contexto correcto al que le falta `medications`, o
 * `baseline.sleepHours`, o `deltas.hrv` —campos que loop-voice ni siquiera
 * necesita para conversar— el `safeParse` falla y el cliente **descarta el
 * payload live entero** y sirve el fixture.
 *
 * Ese modo de fallo es peor que un error, porque es silencioso: la llamada no
 * se cae, el agente habla con aplomo, y esta citando la frecuencia cardiaca del
 * FIXTURE (118 bpm) mientras el dashboard de Carlos pinta la de verdad. En el
 * escenario eso se ve como dos numeros distintos para el mismo paciente.
 *
 * Este modulo se interpone antes de la validacion y rellena lo que falta,
 * siguiendo tres reglas:
 *
 *   1. **Nunca se fabrica un numero clinico que el agente vaya a locutar.**
 *      Lo que falta se rellena con un centinela que el prompt sabe omitir
 *      (0 en las medias del baseline, `null` en la severidad), no con un valor
 *      verosimil inventado.
 *   2. **Lo derivable se deriva, no se inventa.** Si faltan los `deltas`, se
 *      calculan a partir de `current` y `baseline`, que son datos reales de
 *      Kiwis. Es aritmetica sobre dato medido, no una suposicion.
 *   3. **Lo esencial no se rellena.** Si no hay frecuencia cardiaca actual ni
 *      de referencia, esto NO es un contexto utilizable: se devuelve `null` y
 *      el cliente degrada a cache/fixture como siempre. Rellenar aqui seria
 *      convertir un payload roto en uno que parece bueno.
 *
 * Puro y sin I/O: no lee `process.env`, no toca la red, no usa el reloj.
 */

import type { SafetyEnvelope } from '../types.js';

// -----------------------------------------------------------------------------
// Resultado
// -----------------------------------------------------------------------------

export interface CoercionResult {
  /** Payload listo para `patientContextSchema.safeParse`. */
  value: Record<string, unknown>;
  /** Rutas que hubo que rellenar. Vacio = el payload venia completo. */
  filled: string[];
}

/**
 * Envelope de respaldo. Son los mismos valores que el brief usa en su ejemplo y
 * que traen los dos fixtures compartidos.
 *
 * Si Kiwis omite `safetyEnvelope`, la alternativa actual (descartar el payload)
 * termina igualmente usando ESTOS numeros —los del fixture— pero perdiendo por
 * el camino la biometria real. Rellenar es estrictamente mejor: RF-08 sigue
 * siendo evaluable y las lecturas que evalua son las de verdad.
 */
export const DEFAULT_SAFETY_ENVELOPE: SafetyEnvelope = Object.freeze({
  heartRateMax: 150,
  heartRateMin: 40,
  respiratoryRateMax: 32,
  spo2Min: 92,
  note: 'Envelope por defecto: loop-core no lo envio en este contexto.',
});

// -----------------------------------------------------------------------------
// Utilidades de lectura tolerante
// -----------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Numero finito, aceptando la forma string ("34"). null si no lo es. */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Valor de una union CERRADA del contrato, o `fallback` si no es ninguno.
 *
 * El contrato provisional declaraba `trend`, `carePlanActivity.type`,
 * `clinicalStatus`, `medication.status` y `resolution` como `z.string()` a
 * proposito: un valor inesperado de loop-core no podia tirar la llamada. El
 * contrato oficial los cerro a `z.enum(...)`, asi que ahora **un solo valor
 * inesperado invalida el contexto entero** y el agente vuelve a locutar cifras
 * del fixture mientras el dashboard pinta las reales. La tolerancia se
 * reconstruye aqui, que es donde toca: en el lado de voice/, sin tocar shared/.
 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

const TRENDS = ['rising', 'falling', 'stable'] as const;
const CLINICAL_STATUSES = ['active', 'remission', 'resolved'] as const;
const MEDICATION_STATUSES = ['active', 'stopped', 'on-hold'] as const;
const RESOLUTIONS = [
  'self-resolved',
  'resolved-with-intervention',
  'escalated-emergency',
  'escalated-human',
  'abandoned',
] as const;
const ACTIVITY_TYPES = [
  'breathing',
  'grounding',
  'cognitive',
  'physical',
  'escalation-soft',
] as const;

// -----------------------------------------------------------------------------
// Normalizadores por bloque
// -----------------------------------------------------------------------------

/**
 * Media del baseline. **0 es el centinela de "no lo se"**: `buildSystemPrompt`
 * omite la linea entera cuando la media no es positiva, asi que un baseline
 * ausente nunca se convierte en una frase locutada.
 */
function baselineMetric(raw: unknown, unit: string): Record<string, unknown> {
  const source = isRecord(raw) ? raw : {};
  return {
    mean: num(source['mean']) ?? 0,
    sd: num(source['sd']) ?? 0,
    unit: str(source['unit'], unit),
  };
}

/** Metrica actual "que sube": `max` cae a `latest` si no viene. */
function currentRising(raw: unknown, unit: string): Record<string, unknown> | null {
  const source = isRecord(raw) ? raw : {};
  const latest = num(source['latest']);
  if (latest === null) return null;
  return {
    latest,
    max: num(source['max']) ?? latest,
    trend: oneOf(source['trend'], TRENDS, 'stable'),
    unit: str(source['unit'], unit),
  };
}

/** Metrica actual "que baja": `min` cae a `latest` si no viene. */
function currentFalling(raw: unknown, unit: string): Record<string, unknown> | null {
  const source = isRecord(raw) ? raw : {};
  const latest = num(source['latest']);
  if (latest === null) return null;
  return {
    latest,
    min: num(source['min']) ?? latest,
    trend: oneOf(source['trend'], TRENDS, 'stable'),
    unit: str(source['unit'], unit),
  };
}

/**
 * Delta de una metrica. Si Kiwis no lo manda se DERIVA de `latest` y del
 * baseline: aritmetica sobre dos numeros medidos, no una invencion.
 * Con `sd <= 0` la desviacion tipificada no existe y se deja en 0 (el prompt
 * imprime la linea igual, pero sin afirmar una desviacion que no se puede
 * calcular... por eso 0 y no un valor arbitrario).
 */
function delta(raw: unknown, latest: number | null, mean: number, sd: number): Record<string, unknown> {
  const source = isRecord(raw) ? raw : {};
  const absoluteRaw = num(source['absolute']);
  const sdRaw = num(source['sdFromBaseline']);
  if (absoluteRaw !== null && sdRaw !== null) {
    return { absolute: absoluteRaw, sdFromBaseline: sdRaw };
  }
  const absolute = absoluteRaw ?? (latest !== null ? latest - mean : 0);
  const sdFromBaseline = sdRaw ?? (sd > 0 && latest !== null ? (latest - mean) / sd : 0);
  return {
    absolute: Math.round(absolute * 10) / 10,
    sdFromBaseline: Math.round(sdFromBaseline * 10) / 10,
  };
}

function condition(raw: unknown): Record<string, unknown> {
  const source = isRecord(raw) ? raw : {};
  return {
    code: str(source['code']),
    system: str(source['system']),
    display: str(source['display']),
    onsetDate: str(source['onsetDate']),
    // Sin estado conocido se asume `active`: es el unico valor del enum que no
    // le quita peso clinico a una condicion que loop-core si nos mando.
    clinicalStatus: oneOf(source['clinicalStatus'], CLINICAL_STATUSES, 'active'),
  };
}

function activity(raw: unknown, index: number): Record<string, unknown> {
  const source = isRecord(raw) ? raw : {};
  const out: Record<string, unknown> = {
    id: str(source['id'], `cp-act-${index + 1}`),
    order: num(source['order']) ?? index + 1,
    // `cognitive` es el respaldo deliberado: cae en la rama `default` de
    // `planIntervention` (se locuta el guion tal cual, sin timing propio), que
    // es exactamente lo que hay que hacer con una actividad que no sabemos leer.
    type: oneOf(source['type'], ACTIVITY_TYPES, 'cognitive'),
    title: str(source['title'], 'Actividad del plan'),
    instruction: str(source['instruction']),
  };
  // Los opcionales se copian SOLO si vienen: el schema los admite ausentes y
  // asi `activity.voiceScript !== undefined` sigue significando lo que dice.
  const duration = num(source['durationMinutes']);
  if (duration !== null) out['durationMinutes'] = duration;
  if (typeof source['voiceScript'] === 'string') out['voiceScript'] = source['voiceScript'];

  const cost = source['costItem'];
  if (isRecord(cost) && typeof cost['serviceType'] === 'string') {
    out['costItem'] = { serviceType: cost['serviceType'], cptCode: str(cost['cptCode']) };
  }
  return out;
}

function recentEpisode(raw: unknown): Record<string, unknown> {
  const source = isRecord(raw) ? raw : {};
  return {
    encounterId: str(source['encounterId']),
    startedAt: str(source['startedAt']),
    durationMinutes: num(source['durationMinutes']) ?? 0,
    peakHeartRate: num(source['peakHeartRate']) ?? 0,
    interventions: arr(source['interventions']).filter((i): i is string => typeof i === 'string'),
    // Un episodio pasado cuyo desenlace no reconocemos se cuenta como
    // `self-resolved`: es el desenlace que NO afirma que hubo intervencion ni
    // escalacion. El prompt solo lo lista como historia.
    resolution: oneOf(source['resolution'], RESOLUTIONS, 'self-resolved'),
    severitySelfReported: num(source['severitySelfReported']),
  };
}

function medication(raw: unknown): Record<string, unknown> {
  const source = isRecord(raw) ? raw : {};
  return {
    display: str(source['display']),
    status: oneOf(source['status'], MEDICATION_STATUSES, 'active'),
    rxnorm: str(source['rxnorm']),
    // Ausente => false. loop-voice no verifica cobertura de medicacion (esta
    // fuera de alcance por diseño), asi que el valor conservador es el que no
    // habilita nada.
    coverageCheckable: source['coverageCheckable'] === true,
  };
}

function safetyEnvelope(raw: unknown): { value: Record<string, unknown>; complete: boolean } {
  const source = isRecord(raw) ? raw : {};
  const hrMax = num(source['heartRateMax']);
  const hrMin = num(source['heartRateMin']);
  const rrMax = num(source['respiratoryRateMax']);
  const spo2Min = num(source['spo2Min']);
  // `complete` habla SOLO de los umbrales: son los cuatro numeros que evalua
  // RF-08. `note` es prosa que no se locuta nunca, asi que su ausencia no
  // convierte al envelope en incompleto — pero el contrato la exige, y sin
  // rellenarla el payload live entero se caia a favor del fixture.
  const complete = hrMax !== null && hrMin !== null && rrMax !== null && spo2Min !== null;

  const note = source['note'];
  const value: Record<string, unknown> = {
    heartRateMax: hrMax ?? DEFAULT_SAFETY_ENVELOPE.heartRateMax,
    heartRateMin: hrMin ?? DEFAULT_SAFETY_ENVELOPE.heartRateMin,
    respiratoryRateMax: rrMax ?? DEFAULT_SAFETY_ENVELOPE.respiratoryRateMax,
    spo2Min: spo2Min ?? DEFAULT_SAFETY_ENVELOPE.spo2Min,
    note: typeof note === 'string' ? note : DEFAULT_SAFETY_ENVELOPE.note,
  };

  return { value, complete };
}

// -----------------------------------------------------------------------------
// coerceContext
// -----------------------------------------------------------------------------

/**
 * Normaliza un contexto de loop-core para que pase `patientContextSchema`.
 *
 * @returns `null` si el payload no trae lo esencial (frecuencia cardiaca actual
 *          y de referencia). En ese caso el cliente debe degradar a cache o
 *          fixture: convertir eso en un contexto "valido" seria mentir.
 */
export function coerceContext(raw: unknown): CoercionResult | null {
  if (!isRecord(raw)) return null;

  const filled: string[] = [];
  const mark = (path: string, missing: boolean): void => {
    if (missing) filled.push(path);
  };

  // --- lo esencial ------------------------------------------------------------
  const rawCurrent = isRecord(raw['current']) ? raw['current'] : {};
  const rawBaseline = isRecord(raw['baseline']) ? raw['baseline'] : {};

  const heartRate = currentRising(rawCurrent['heartRate'], 'bpm');
  const baselineHeartRate = baselineMetric(rawBaseline['heartRate'], 'bpm');
  if (heartRate === null || (baselineHeartRate['mean'] as number) <= 0) return null;

  // --- baseline ---------------------------------------------------------------
  mark('baseline.hrv', !isRecord(rawBaseline['hrv']));
  mark('baseline.respiratoryRate', !isRecord(rawBaseline['respiratoryRate']));
  mark('baseline.sleepHours', !isRecord(rawBaseline['sleepHours']));

  const baseline = {
    heartRate: baselineHeartRate,
    hrv: baselineMetric(rawBaseline['hrv'], 'ms'),
    respiratoryRate: baselineMetric(rawBaseline['respiratoryRate'], 'breaths/min'),
    sleepHours: baselineMetric(rawBaseline['sleepHours'], 'h'),
  };

  // --- current ----------------------------------------------------------------
  const hrv = currentFalling(rawCurrent['hrv'], 'ms');
  const respiratoryRate = currentRising(rawCurrent['respiratoryRate'], 'breaths/min');
  mark('current.hrv', hrv === null);
  mark('current.respiratoryRate', respiratoryRate === null);
  mark('current.windowMinutes', num(rawCurrent['windowMinutes']) === null);

  const current: Record<string, unknown> = {
    windowMinutes: num(rawCurrent['windowMinutes']) ?? 30,
    heartRate,
    // Sin lectura: `latest: 0`. `buildSystemPrompt` omite la linea (0 no es una
    // constante vital positiva) y `checkEnvelope` ignora los no-positivos, asi
    // que un HRV ausente no puede disparar ni silenciar una regla.
    hrv: hrv ?? { latest: 0, min: 0, trend: 'stable', unit: 'ms' },
    respiratoryRate:
      respiratoryRate ?? { latest: 0, max: 0, trend: 'stable', unit: 'breaths/min' },
    lastSampleAt: str(rawCurrent['lastSampleAt']),
  };
  const spo2 = currentFalling(rawCurrent['spo2'], '%');
  if (spo2 !== null) current['spo2'] = spo2;

  // --- deltas (derivados si faltan) -------------------------------------------
  const rawDeltas = isRecord(raw['deltas']) ? raw['deltas'] : {};
  mark('deltas.heartRate', !isRecord(rawDeltas['heartRate']));
  mark('deltas.hrv', !isRecord(rawDeltas['hrv']));

  const deltas: Record<string, unknown> = {
    heartRate: delta(
      rawDeltas['heartRate'],
      heartRate['latest'] as number,
      baseline.heartRate['mean'] as number,
      baseline.heartRate['sd'] as number,
    ),
    hrv: delta(
      rawDeltas['hrv'],
      hrv === null ? null : (hrv['latest'] as number),
      baseline.hrv['mean'] as number,
      baseline.hrv['sd'] as number,
    ),
  };
  if (isRecord(rawDeltas['respiratoryRate'])) {
    deltas['respiratoryRate'] = delta(
      rawDeltas['respiratoryRate'],
      respiratoryRate === null ? null : (respiratoryRate['latest'] as number),
      baseline.respiratoryRate['mean'] as number,
      baseline.respiratoryRate['sd'] as number,
    );
  }

  // --- care plan --------------------------------------------------------------
  const rawPlan = isRecord(raw['carePlan']) ? raw['carePlan'] : {};
  mark('carePlan', !isRecord(raw['carePlan']));
  const carePlan = {
    id: str(rawPlan['id']),
    authoredBy: str(rawPlan['authoredBy'], 'tu equipo de cuidado'),
    lastUpdated: str(rawPlan['lastUpdated']),
    activities: arr(rawPlan['activities']).map(activity),
  };

  // --- listas -----------------------------------------------------------------
  mark('conditions', !Array.isArray(raw['conditions']));
  mark('recentEpisodes', !Array.isArray(raw['recentEpisodes']));
  mark('medications', !Array.isArray(raw['medications']));

  // --- envelope ---------------------------------------------------------------
  const envelope = safetyEnvelope(raw['safetyEnvelope']);
  mark('safetyEnvelope', !envelope.complete);

  mark('age', num(raw['age']) === null);
  mark('displayName', typeof raw['displayName'] !== 'string' || raw['displayName'].trim() === '');

  const value: Record<string, unknown> = {
    patientId: str(raw['patientId']),
    // Sin nombre no se saluda por nombre: "la persona" es honesto y no rompe
    // `displayName.split(' ')[0]`.
    displayName: str(raw['displayName']).trim() === '' ? 'la persona' : str(raw['displayName']),
    // 0 = "no registrada". El prompt no dice "0 años", omite la edad.
    age: num(raw['age']) ?? 0,
    generatedAt: str(raw['generatedAt']),
    baseline,
    current,
    deltas,
    conditions: arr(raw['conditions']).map(condition),
    carePlan,
    recentEpisodes: arr(raw['recentEpisodes']).map(recentEpisode),
    medications: arr(raw['medications']).map(medication),
    safetyEnvelope: envelope.value,
  };

  return { value, filled };
}
