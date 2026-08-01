/**
 * Lecturas del expediente — SOLO SERVIDOR.
 *
 * Una sola tanda de peticiones en paralelo por pantalla, para que el expediente
 * no se pinte a trozos delante de un jurado. Cada lectura pasa por `medplumRead`,
 * así que **ninguna lanza**: el peor caso es el respaldo marcado en pantalla.
 *
 * Los fixtures de respaldo NO son inventados: son la captura literal de este
 * mismo proyecto de Medplum, con la forma real —incluidos sus huecos—. Si el
 * wifi muere en el escenario, lo que se ve sigue siendo cierto, solo que
 * congelado, y el badge lo dice. Un respaldo bonito pero falso sería peor que
 * una pantalla vacía.
 */

import 'server-only';

import type {
  AllergyIntolerance,
  Appointment,
  CareTeam,
  Condition,
  DocumentReference,
  MedicationRequest,
  Observation,
  Patient,
  ServiceRequest,
} from '@medplum/fhirtypes';

import allergyFixture from '@/fixtures/medplum/AllergyIntolerance.json';
import appointmentFixture from '@/fixtures/medplum/Appointment.json';
import careTeamFixture from '@/fixtures/medplum/CareTeam.json';
import conditionFixture from '@/fixtures/medplum/Condition.json';
import documentFixture from '@/fixtures/medplum/DocumentReference.json';
import medicationFixture from '@/fixtures/medplum/MedicationRequest.json';
import observationFixture from '@/fixtures/medplum/Observation.json';
import patientFixture from '@/fixtures/medplum/Patient.json';
import serviceRequestFixture from '@/fixtures/medplum/ServiceRequest.json';

import { aggregateChartSource, medplumRead, type ChartResult } from '../medplum/server';
import { computePatientFlags } from './insights';
import {
  mapAllergy,
  mapAppointment,
  mapCareTeam,
  mapCondition,
  mapMedication,
  mapMetrics,
  mapNote,
  mapOrder,
  mapPatient,
} from './map';
import { priorityFor } from './reference-ranges';
import type { ChartMetric, PatientChart, RosterEntry } from './types';

/* Los JSON importados llegan como `any` estructural; el cast documenta que la
 * captura salió de este mismo servidor FHIR y por tanto ya cumple el esquema. */
const FIXTURES = {
  patients: patientFixture as Patient[],
  conditions: conditionFixture as Condition[],
  allergies: allergyFixture as AllergyIntolerance[],
  medications: medicationFixture as MedicationRequest[],
  observations: observationFixture as Observation[],
  documents: documentFixture as DocumentReference[],
  orders: serviceRequestFixture as ServiceRequest[],
  careTeams: careTeamFixture as CareTeam[],
  appointments: appointmentFixture as Appointment[],
};

/** Tope de recursos por búsqueda. Este proyecto es pequeño; sobra de largo. */
const PAGE_SIZE = 200;

/* ================================================================== */
/* Lecturas crudas                                                     */
/* ================================================================== */

function readPatients(): Promise<ChartResult<Patient[]>> {
  return medplumRead(
    (medplum) => medplum.searchResources('Patient', { _count: PAGE_SIZE }).then((r) => [...r]),
    FIXTURES.patients,
  );
}

function readAppointments(): Promise<ChartResult<Appointment[]>> {
  return medplumRead(
    (medplum) => medplum.searchResources('Appointment', { _count: PAGE_SIZE }).then((r) => [...r]),
    FIXTURES.appointments,
  );
}

/**
 * Filtra un fixture por paciente, imitando el `?subject=` / `?patient=` real.
 *
 * Se miran los DOS campos a propósito: casi todos los recursos apuntan al
 * paciente con `subject`, pero `AllergyIntolerance` usa `patient`. Cubrir ambos
 * aquí evita tener dos helpers casi idénticos y que alguien use el que no toca.
 */
function forPatient<T extends { subject?: { reference?: string }; patient?: { reference?: string } }>(
  resources: readonly T[],
  patientId: string,
): T[] {
  const reference = `Patient/${patientId}`;
  return resources.filter(
    (r) => r.subject?.reference === reference || r.patient?.reference === reference,
  );
}

/* ================================================================== */
/* Roster — la agenda                                                  */
/* ================================================================== */

export interface Roster {
  entries: RosterEntry[];
  source: ChartResult<null>;
  /** Clínico que atiende, tomado de las citas. `null` si no hay ninguna. */
  practitioner: string | null;
}

/**
 * Lista de pacientes con lo justo para triar de un vistazo.
 *
 * Trae medicación, condiciones y observaciones de TODOS los pacientes de una
 * vez y las reparte en memoria, en vez de hacer N peticiones por paciente: con
 * tres pacientes la diferencia es de una petición contra diez, y el roster es
 * la primera pantalla que ve el jurado.
 */
export async function readRoster(now: Date): Promise<Roster> {
  const [patients, appointments, conditions, medications, observations, allergies] =
    await Promise.all([
      readPatients(),
      readAppointments(),
      medplumRead(
        (m) => m.searchResources('Condition', { _count: PAGE_SIZE }).then((r) => [...r]),
        FIXTURES.conditions,
      ),
      medplumRead(
        (m) => m.searchResources('MedicationRequest', { _count: PAGE_SIZE }).then((r) => [...r]),
        FIXTURES.medications,
      ),
      medplumRead(
        (m) => m.searchResources('Observation', { _count: PAGE_SIZE }).then((r) => [...r]),
        FIXTURES.observations,
      ),
      medplumRead(
        (m) => m.searchResources('AllergyIntolerance', { _count: PAGE_SIZE }).then((r) => [...r]),
        FIXTURES.allergies,
      ),
    ]);

  const mappedAppointments = appointments.data.map(mapAppointment);
  const nowMs = now.getTime();

  const entries: RosterEntry[] = patients.data
    .map((resource) => mapPatient(resource, now))
    // El Patient inactivo y sin nombre del proyecto no es un paciente: es basura
    // de pruebas. Se filtra aquí y no en la UI para que ningún componente tenga
    // que conocer esa excepción.
    .filter((patient) => patient.active && patient.id !== '')
    .map((patient) => {
      const patientConditions = forPatient(conditions.data, patient.id).map(mapCondition);
      const patientMedications = forPatient(medications.data, patient.id).map(mapMedication);
      const patientAllergies = forPatient(allergies.data, patient.id).map(mapAllergy);
      const metrics = sortMetrics(mapMetrics(forPatient(observations.data, patient.id)));

      const flags = computePatientFlags({
        metrics,
        medications: patientMedications,
        conditions: patientConditions,
        allergies: patientAllergies,
        now: nowMs,
      });

      const patientAppointments = mappedAppointments
        .filter((a) => a.patientId === patient.id)
        .sort((a, b) => Date.parse(a.start ?? '') - Date.parse(b.start ?? ''));

      // Preferimos la próxima cita futura; si no hay ninguna, la más reciente.
      // Una agenda que solo mira al futuro deja al paciente sin contexto el día
      // después de su consulta.
      const upcoming = patientAppointments.find((a) => Date.parse(a.start ?? '') >= nowMs);

      return {
        patient,
        nextAppointment: upcoming ?? patientAppointments[patientAppointments.length - 1] ?? null,
        activeConditions: patientConditions
          .filter((c) => c.clinicalStatus === 'active')
          .map((c) => c.display),
        activeMedicationCount: patientMedications.filter((m) => m.status === 'active').length,
        headlineMetric: pickHeadlineMetric(metrics),
        flags,
      };
    })
    // Orden del roster: primero quien tiene la señal más grave. Ordenar por
    // hora de cita pondría arriba al paciente sano de las 9:00 y escondería el
    // que necesita una decisión hoy.
    .sort((a, b) => severityRank(a) - severityRank(b));

  return {
    entries,
    source: aggregateChartSource([patients, appointments, conditions, medications, observations]),
    practitioner: mappedAppointments.find((a) => a.practitioner)?.practitioner ?? null,
  };
}

function severityRank(entry: RosterEntry): number {
  if (entry.flags.some((f) => f.severity === 'danger')) return 0;
  if (entry.flags.some((f) => f.severity === 'warn')) return 1;
  return 2;
}

/** Ordena por importancia clínica; a igualdad, alfabéticamente para ser estable. */
function sortMetrics(metrics: ChartMetric[]): ChartMetric[] {
  return [...metrics].sort((a, b) => {
    const byPriority = priorityFor(a.loinc) - priorityFor(b.loinc);
    return byPriority !== 0 ? byPriority : a.label.localeCompare(b.label, 'en');
  });
}

/**
 * La métrica que define el estado del paciente hoy: la de peor señal, y a
 * igualdad de señal la clínicamente más importante.
 */
function pickHeadlineMetric(metrics: readonly ChartMetric[]): ChartMetric | null {
  const withValue = metrics.filter((m) => m.latest !== null);
  if (withValue.length === 0) return null;

  const rank = (metric: ChartMetric): number => {
    const flag = metric.latest?.flag;
    if (flag === 'critical-high' || flag === 'critical-low') return 0;
    if (metric.trend?.clinical === 'worsening') return 1;
    if (flag === 'high' || flag === 'low') return 2;
    return 3;
  };

  return [...withValue].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    return byRank !== 0 ? byRank : priorityFor(a.loinc) - priorityFor(b.loinc);
  })[0];
}

/* ================================================================== */
/* Expediente de un paciente                                           */
/* ================================================================== */

export interface PatientChartResult {
  chart: PatientChart | null;
  source: ChartResult<null>;
}

/**
 * Expediente completo. Devuelve `chart: null` cuando el paciente no existe ni
 * en Medplum ni en el respaldo — el caso de una URL escrita a mano.
 */
export async function readPatientChart(
  patientId: string,
  now: Date,
): Promise<PatientChartResult> {
  const query = { subject: `Patient/${patientId}`, _count: PAGE_SIZE };

  const [patient, conditions, allergies, medications, observations, notes, orders, careTeams, appointments] =
    await Promise.all([
      medplumRead<Patient | null>(
        (m) => m.readResource('Patient', patientId),
        FIXTURES.patients.find((p) => p.id === patientId) ?? null,
      ),
      medplumRead(
        (m) => m.searchResources('Condition', query).then((r) => [...r]),
        forPatient(FIXTURES.conditions, patientId),
      ),
      medplumRead(
        (m) => m.searchResources('AllergyIntolerance', { patient: `Patient/${patientId}`, _count: PAGE_SIZE }).then((r) => [...r]),
        forPatient(FIXTURES.allergies, patientId),
      ),
      medplumRead(
        (m) => m.searchResources('MedicationRequest', query).then((r) => [...r]),
        forPatient(FIXTURES.medications, patientId),
      ),
      medplumRead(
        (m) => m.searchResources('Observation', query).then((r) => [...r]),
        forPatient(FIXTURES.observations, patientId),
      ),
      medplumRead(
        (m) => m.searchResources('DocumentReference', query).then((r) => [...r]),
        forPatient(FIXTURES.documents, patientId),
      ),
      medplumRead(
        (m) => m.searchResources('ServiceRequest', query).then((r) => [...r]),
        forPatient(FIXTURES.orders, patientId),
      ),
      medplumRead(
        (m) => m.searchResources('CareTeam', { patient: `Patient/${patientId}`, _count: PAGE_SIZE }).then((r) => [...r]),
        FIXTURES.careTeams,
      ),
      readAppointments(),
    ]);

  if (!patient.data) {
    return {
      chart: null,
      source: aggregateChartSource([patient]),
    };
  }

  const chart: PatientChart = {
    patient: mapPatient(patient.data, now),
    conditions: conditions.data.map(mapCondition),
    allergies: allergies.data.map(mapAllergy),
    medications: medications.data.map(mapMedication).sort(byActiveThenRecent),
    metrics: sortMetrics(mapMetrics(observations.data)),
    notes: notes.data.map(mapNote),
    orders: orders.data.map(mapOrder),
    careTeam: careTeams.data.flatMap(mapCareTeam),
    appointments: appointments.data
      .map(mapAppointment)
      .filter((a) => a.patientId === patientId)
      .sort((a, b) => Date.parse(a.start ?? '') - Date.parse(b.start ?? '')),
  };

  return {
    chart,
    source: aggregateChartSource([
      patient,
      conditions,
      allergies,
      medications,
      observations,
      notes,
      orders,
    ]),
  };
}

/** Activas primero; dentro de cada grupo, la más reciente arriba. */
function byActiveThenRecent(
  a: { status: string; authoredOn: string | null },
  b: { status: string; authoredOn: string | null },
): number {
  const activeA = a.status === 'active' ? 0 : 1;
  const activeB = b.status === 'active' ? 0 : 1;
  if (activeA !== activeB) return activeA - activeB;
  return Date.parse(b.authoredOn ?? '') - Date.parse(a.authoredOn ?? '');
}

/** Banderas del expediente ya cargado, sin volver a pedir nada. */
export function chartFlags(chart: PatientChart, now: Date) {
  return computePatientFlags({
    metrics: chart.metrics,
    medications: chart.medications,
    conditions: chart.conditions,
    allergies: chart.allergies,
    now: now.getTime(),
  });
}
