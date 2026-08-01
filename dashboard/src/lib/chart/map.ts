/**
 * Traducción FHIR → modelo del expediente.
 *
 * Todo el conocimiento sucio de FHIR se paga aquí, una vez, para que ningún
 * componente tenga que saber que la presión arterial guarda sus cifras en
 * `component[]` o que `medicationCodeableConcept` puede venir sin `text`.
 *
 * Regla de este archivo: **defensivo hasta la paranoia y sin inventar nunca.**
 * Cada campo de FHIR es opcional en el esquema, y el dataset real ya demuestra
 * que la opcionalidad no es teórica: faltan `onsetDateTime`, falta `requester`,
 * el panel de presión trae `valueQuantity` nulo. Ante un campo ausente se
 * devuelve `null` y la UI pinta un guion. Nunca un cero, nunca una suposición.
 */

import type {
  AllergyIntolerance,
  Appointment,
  CareTeam,
  CodeableConcept,
  Condition,
  DocumentReference,
  HumanName,
  MedicationRequest,
  Observation,
  Patient,
  Reference,
  ServiceRequest,
} from '@medplum/fhirtypes';

import { computeTrend, flagValue } from './insights';
import { labelFor, referenceRangeFor } from './reference-ranges';
import type {
  ChartAllergy,
  ChartAppointment,
  ChartCareTeamMember,
  ChartCondition,
  ChartMedication,
  ChartMetric,
  ChartNote,
  ChartObservationPoint,
  ChartOrder,
  ChartPatient,
  MedicationStatus,
} from './types';

/* ================================================================== */
/* Utilidades comunes                                                  */
/* ================================================================== */

/** Primer coding con `system` LOINC/RxNorm/lo que sea, o el primero que haya. */
function firstCoding(concept: CodeableConcept | undefined) {
  return concept?.coding?.[0];
}

/**
 * Texto legible de un CodeableConcept, en orden de preferencia:
 * `text` (lo que escribió el clínico) → `coding[].display` → el código pelado.
 */
function conceptText(concept: CodeableConcept | undefined, fallback: string): string {
  const text = concept?.text?.trim();
  if (text) return text;

  for (const coding of concept?.coding ?? []) {
    const display = coding.display?.trim();
    if (display) return display;
  }

  const code = firstCoding(concept)?.code?.trim();
  return code || fallback;
}

/** Código de un sistema concreto; `null` si el concepto no lo tiene. */
function codeFromSystem(concept: CodeableConcept | undefined, systemFragment: string): string | null {
  for (const coding of concept?.coding ?? []) {
    if (coding.system?.includes(systemFragment) && coding.code) {
      return coding.code;
    }
  }
  return null;
}

function displayFromSystem(
  concept: CodeableConcept | undefined,
  systemFragment: string,
): string | null {
  for (const coding of concept?.coding ?? []) {
    if (coding.system?.includes(systemFragment) && coding.display) {
      return coding.display;
    }
  }
  return null;
}

/** Nombre de una referencia FHIR: solo el `display`, sin resolver el recurso. */
function referenceName(reference: Reference | undefined): string | null {
  const display = reference?.display?.trim();
  return display ? display : null;
}

function humanName(names: HumanName[] | undefined): string | null {
  for (const name of names ?? []) {
    const given = (name.given ?? []).filter(Boolean).join(' ').trim();
    const family = (name.family ?? '').trim();
    const full = [given, family].filter(Boolean).join(' ').trim();
    if (full) return full;
    const text = name.text?.trim();
    if (text) return text;
  }
  return null;
}

/**
 * Edad en años cumplidos a partir de `birthDate`.
 *
 * `now` se inyecta para que la función sea pura: si leyera el reloj, servidor y
 * cliente podrían discrepar en un año justo el día del cumpleaños y React
 * marcaría un error de hidratación en mitad del demo.
 */
export function ageFromBirthDate(birthDate: string | undefined, now: Date): number | null {
  if (!birthDate) return null;
  const born = new Date(birthDate);
  if (Number.isNaN(born.getTime())) return null;

  let age = now.getUTCFullYear() - born.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - born.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < born.getUTCDate())) {
    age -= 1;
  }
  return age >= 0 && age < 130 ? age : null;
}

/* ================================================================== */
/* Paciente                                                            */
/* ================================================================== */

export function mapPatient(resource: Patient, now: Date): ChartPatient {
  const gender = resource.gender;
  return {
    id: resource.id ?? '',
    // Un Patient sin nombre existe de verdad en este proyecto. Se etiqueta como
    // lo que es en vez de dejar la fila en blanco.
    displayName: humanName(resource.name) ?? 'Paciente sin nombre',
    age: ageFromBirthDate(resource.birthDate, now),
    birthDate: resource.birthDate ?? null,
    gender:
      gender === 'female' || gender === 'male' || gender === 'other' || gender === 'unknown'
        ? gender
        : null,
    mrn: resource.identifier?.find((i) => i.value)?.value ?? null,
    // `active` ausente significa activo en FHIR: solo `false` explícito desactiva.
    active: resource.active !== false,
  };
}

/* ================================================================== */
/* Problemas                                                           */
/* ================================================================== */

const CONDITION_STATUSES = new Set([
  'active',
  'recurrence',
  'relapse',
  'inactive',
  'remission',
  'resolved',
]);

export function mapCondition(resource: Condition): ChartCondition {
  const status = firstCoding(resource.clinicalStatus)?.code;
  // Se prefiere ICD-10 sobre el resto: es el código que un médico reconoce de
  // un vistazo, frente al `mms` de la CIE-11 que casi nadie lee todavía.
  const icd10 = codeFromSystem(resource.code, 'icd-10');
  const anyCoding = firstCoding(resource.code);

  return {
    id: resource.id ?? '',
    display: conceptText(resource.code, 'Diagnóstico sin descripción'),
    code: icd10 ?? anyCoding?.code ?? null,
    codeSystem: icd10 ? 'ICD-10-CM' : (anyCoding?.system ?? null),
    onsetDate: resource.onsetDateTime ?? resource.onsetPeriod?.start ?? null,
    clinicalStatus:
      status && CONDITION_STATUSES.has(status) ? (status as ChartCondition['clinicalStatus']) : null,
    recordedDate: resource.recordedDate ?? null,
  };
}

/* ================================================================== */
/* Alergias                                                            */
/* ================================================================== */

export function mapAllergy(resource: AllergyIntolerance): ChartAllergy {
  const status = firstCoding(resource.clinicalStatus)?.code;
  const reactions: string[] = [];

  for (const reaction of resource.reaction ?? []) {
    for (const manifestation of reaction.manifestation ?? []) {
      const text = conceptText(manifestation, '');
      if (text) reactions.push(text);
    }
  }

  return {
    id: resource.id ?? '',
    display: conceptText(resource.code, 'Alérgeno sin descripción'),
    code: codeFromSystem(resource.code, 'rxnorm') ?? firstCoding(resource.code)?.code ?? null,
    reactions,
    criticality:
      resource.criticality === 'low' ||
      resource.criticality === 'high' ||
      resource.criticality === 'unable-to-assess'
        ? resource.criticality
        : null,
    clinicalStatus:
      status === 'active' || status === 'inactive' || status === 'resolved' ? status : null,
    recordedDate: resource.recordedDate ?? null,
    note: resource.note?.map((n) => n.text).filter(Boolean).join(' ') || null,
  };
}

/* ================================================================== */
/* Medicación                                                          */
/* ================================================================== */

const MEDICATION_STATUSES = new Set<MedicationStatus>([
  'active',
  'on-hold',
  'cancelled',
  'completed',
  'stopped',
  'draft',
  'entered-in-error',
  'unknown',
]);

/** Detecta una pauta a demanda por el texto, cuando falta `asNeededBoolean`. */
const AS_NEEDED_PATTERN = /\b(solo si|si hay|a demanda|rescate|prn|as needed|en caso de)\b/i;

export function mapMedication(resource: MedicationRequest): ChartMedication {
  const concept = resource.medicationCodeableConcept;
  const dosageInstruction = resource.dosageInstruction?.[0];
  const dosage = dosageInstruction?.text?.trim() || null;
  const status = resource.status;

  return {
    id: resource.id ?? '',
    display: conceptText(concept, referenceName(resource.medicationReference) ?? 'Medicamento'),
    rxnorm: codeFromSystem(concept, 'rxnorm'),
    rxnormDisplay: displayFromSystem(concept, 'rxnorm'),
    status:
      status && MEDICATION_STATUSES.has(status as MedicationStatus)
        ? (status as MedicationStatus)
        : 'unknown',
    dosage,
    authoredOn: resource.authoredOn ?? null,
    // `null` en TODO el dataset real. La UI lo muestra como "sin prescriptor"
    // porque una receta sin firma es un hallazgo, no un campo vacío cualquiera.
    prescriber: referenceName(resource.requester),
    statusReason: resource.statusReason ? conceptText(resource.statusReason, '') || null : null,
    priorPrescriptionId: resource.priorPrescription?.reference?.split('/')[1] ?? null,
    asNeeded:
      dosageInstruction?.asNeededBoolean === true ||
      (dosage !== null && AS_NEEDED_PATTERN.test(dosage)),
  };
}

/* ================================================================== */
/* Observaciones → métricas con serie                                  */
/* ================================================================== */

/** Un punto suelto extraído de una Observation, antes de agruparse en series. */
interface RawPoint {
  loinc: string | null;
  label: string;
  unit: string;
  at: string;
  value: number;
}

/**
 * Aplana una Observation en cero o más puntos.
 *
 * Devuelve VARIOS cuando el recurso es un panel: la presión arterial llega como
 * un `Observation` cuyo `valueQuantity` es nulo y cuyas cifras viven en
 * `component[]`, una por sistólica y otra por diastólica. Tratarlo como un solo
 * valor daría `NaN`, que es exactamente el bug que produce un "—" inexplicable
 * en pantalla.
 */
function flattenObservation(resource: Observation): RawPoint[] {
  const at = resource.effectiveDateTime ?? resource.effectivePeriod?.start ?? resource.issued;
  if (!at) return [];

  const points: RawPoint[] = [];

  const rootValue = resource.valueQuantity?.value;
  if (typeof rootValue === 'number') {
    const loinc = codeFromSystem(resource.code, 'loinc');
    points.push({
      loinc,
      label: labelFor(loinc, conceptText(resource.code, 'Resultado')),
      unit: resource.valueQuantity?.unit ?? '',
      at,
      value: rootValue,
    });
  }

  for (const component of resource.component ?? []) {
    const value = component.valueQuantity?.value;
    if (typeof value !== 'number') continue;

    const loinc = codeFromSystem(component.code, 'loinc');
    points.push({
      loinc,
      // Los componentes de un panel suelen venir SIN display: la etiqueta sale
      // de la tabla local por código LOINC, no del recurso.
      label: labelFor(loinc, conceptText(component.code, 'Componente')),
      unit: component.valueQuantity?.unit ?? '',
      at,
      value,
    });
  }

  return points;
}

/**
 * Agrupa observaciones en métricas con serie temporal, rango y tendencia.
 * El orden de salida lo decide `priorityFor`: manda la importancia clínica,
 * no el orden en que Medplum devolvió el bundle.
 */
export function mapMetrics(resources: readonly Observation[]): ChartMetric[] {
  const buckets = new Map<string, RawPoint[]>();

  for (const resource of resources) {
    for (const point of flattenObservation(resource)) {
      // Sin LOINC se agrupa por etiqueta: peor llave, pero no se pierde el dato.
      const key = point.loinc ?? `label:${point.label}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(point);
      else buckets.set(key, [point]);
    }
  }

  const metrics: ChartMetric[] = [];

  for (const [key, rawPoints] of buckets) {
    const sorted = [...rawPoints].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const first = sorted[0];
    const loinc = first.loinc;
    const range = referenceRangeFor(loinc);

    const points: ChartObservationPoint[] = sorted.map((p) => ({
      at: p.at,
      value: p.value,
      flag: flagValue(p.value, range),
    }));

    metrics.push({
      key,
      label: first.label,
      loinc,
      // La unidad se toma del punto más reciente: si alguna vez cambia, la que
      // vale es la de ahora.
      unit: sorted[sorted.length - 1].unit,
      points,
      latest: points[points.length - 1] ?? null,
      referenceRange: range,
      trend: computeTrend(points, range),
    });
  }

  return metrics;
}

/* ================================================================== */
/* Notas, órdenes, equipo y agenda                                     */
/* ================================================================== */

/** Una URL solo se puede abrir si es absoluta. Las relativas de FHIR no resuelven. */
function isResolvableUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

function decodeAttachment(data: string | undefined): string | null {
  if (!data) return null;
  try {
    // `atob` existe en Node 18+ y en el navegador. Solo se intenta con texto:
    // un PDF embebido saldría como basura, y por eso el llamante filtra por
    // contentType antes de mostrarlo.
    return atob(data);
  } catch {
    return null;
  }
}

export function mapNote(resource: DocumentReference): ChartNote {
  const attachment = resource.content?.[0]?.attachment;
  const isText = attachment?.contentType?.startsWith('text/') ?? false;

  return {
    id: resource.id ?? '',
    title: resource.description?.trim() || conceptText(resource.type, 'Documento'),
    category: conceptText(resource.type, '') || null,
    date: resource.date ?? null,
    author: resource.author?.map((a) => referenceName(a)).find(Boolean) ?? null,
    text: isText ? decodeAttachment(attachment?.data) : null,
    attachmentUrl: attachment?.url ?? null,
    attachmentResolvable: isResolvableUrl(attachment?.url),
    status: resource.status ?? null,
  };
}

export function mapOrder(resource: ServiceRequest): ChartOrder {
  return {
    id: resource.id ?? '',
    display: conceptText(resource.code, 'Orden sin descripción'),
    code: firstCoding(resource.code)?.code ?? null,
    category: resource.category?.[0] ? conceptText(resource.category[0], '') || null : null,
    status: resource.status ?? null,
    intent: resource.intent ?? null,
    authoredOn: resource.authoredOn ?? null,
    requester: referenceName(resource.requester),
    note: resource.note?.map((n) => n.text).filter(Boolean).join(' ') || null,
  };
}

export function mapCareTeam(resource: CareTeam): ChartCareTeamMember[] {
  const members: ChartCareTeamMember[] = [];

  for (const participant of resource.participant ?? []) {
    const name = referenceName(participant.member);
    if (!name) continue;
    members.push({
      id: participant.member?.reference ?? name,
      name,
      role: participant.role?.[0] ? conceptText(participant.role[0], '') || null : null,
    });
  }

  return members;
}

export function mapAppointment(resource: Appointment): ChartAppointment {
  const participants = resource.participant ?? [];
  const patientRef = participants.find((p) => p.actor?.reference?.startsWith('Patient/'));
  // El clínico es el participante que NO es paciente. En este dataset llega solo
  // como `display` ("Dra. Rivera"), sin referencia a un Practitioner real.
  const clinician = participants.find(
    (p) => !p.actor?.reference?.startsWith('Patient/') && p.actor?.display,
  );

  return {
    id: resource.id ?? '',
    patientId: patientRef?.actor?.reference?.split('/')[1] ?? '',
    description: resource.description?.trim() || null,
    start: resource.start ?? null,
    end: resource.end ?? null,
    status: resource.status ?? null,
    practitioner: clinician?.actor?.display ?? null,
  };
}
