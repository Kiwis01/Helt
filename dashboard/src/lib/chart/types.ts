/**
 * Modelo del expediente clínico.
 *
 * Es la forma que consume la UI, no la que devuelve FHIR. La traducción vive en
 * `map.ts` y existe por una razón concreta: FHIR es un formato de intercambio,
 * y pintar directamente un `Observation` obliga a cada componente a saber que la
 * presión arterial guarda sus valores en `component[]` y no en `valueQuantity`.
 * Ese conocimiento se paga una vez, en el mapeador, no en cada tarjeta.
 *
 * Regla que atraviesa todos estos tipos: **lo ausente se representa, no se
 * inventa.** Un `null` aquí significa "Medplum no lo tiene" y la UI lo pinta
 * como un guion, nunca como un cero ni como una suposición. En el dataset real
 * faltan cosas de verdad —ninguna condición trae fecha de inicio, ninguna receta
 * trae quién la firmó— y ocultarlo sería el tipo de mentira que un médico detecta.
 */

/* ================================================================== */
/* Identidad                                                           */
/* ================================================================== */

export interface ChartPatient {
  id: string;
  displayName: string;
  /** `null` cuando no hay `birthDate`: la edad no se estima. */
  age: number | null;
  birthDate: string | null;
  gender: 'female' | 'male' | 'other' | 'unknown' | null;
  /** Identificador del expediente, tipo MRN. `null` si el recurso no trae ninguno. */
  mrn: string | null;
  active: boolean;
}

/* ================================================================== */
/* Problemas y alergias                                                */
/* ================================================================== */

export interface ChartCondition {
  id: string;
  /** Texto clínico legible. Siempre presente: si falta, cae al display del código. */
  display: string;
  /** Código principal para mostrar, p. ej. `E11.9`. `null` si no hay ninguno. */
  code: string | null;
  codeSystem: string | null;
  /** ISO-8601. `null` es lo NORMAL en este dataset: ninguna Condition trae onset. */
  onsetDate: string | null;
  clinicalStatus: 'active' | 'recurrence' | 'relapse' | 'inactive' | 'remission' | 'resolved' | null;
  recordedDate: string | null;
}

export type AllergyCriticality = 'low' | 'high' | 'unable-to-assess' | null;

export interface ChartAllergy {
  id: string;
  display: string;
  code: string | null;
  /** Qué provoca. Vacío cuando no se registró ninguna manifestación. */
  reactions: string[];
  criticality: AllergyCriticality;
  clinicalStatus: 'active' | 'inactive' | 'resolved' | null;
  recordedDate: string | null;
  /** Texto libre del clínico. Es donde vive el matiz que no cabe en un código. */
  note: string | null;
}

/* ================================================================== */
/* Medicación                                                          */
/* ================================================================== */

export type MedicationStatus =
  | 'active'
  | 'on-hold'
  | 'cancelled'
  | 'completed'
  | 'stopped'
  | 'draft'
  | 'entered-in-error'
  | 'unknown';

export interface ChartMedication {
  id: string;
  /** Nombre tal como lo lee el paciente, p. ej. "Metformina 500 mg". */
  display: string;
  /** Código RxNorm. Es lo que permite verificar duplicidad e interacciones. */
  rxnorm: string | null;
  /** Descripción normalizada del RxNorm, en inglés. Útil para desambiguar. */
  rxnormDisplay: string | null;
  status: MedicationStatus;
  /** Instrucción de dosis en lenguaje del paciente. `null` si la receta no la trae. */
  dosage: string | null;
  authoredOn: string | null;
  /** Quién la firmó. `null` en TODO el dataset real: nadie firmó estas recetas. */
  prescriber: string | null;
  /** Motivo de suspensión, cuando `status` es `stopped`. */
  statusReason: string | null;
  /** Receta a la que sustituye. Es lo que convierte un cambio de dosis en una cadena. */
  priorPrescriptionId: string | null;
  /** `true` si el texto de la dosis la marca como rescate / a demanda. */
  asNeeded: boolean;
}

/* ================================================================== */
/* Resultados y signos vitales                                         */
/* ================================================================== */

/** Dónde cae un valor respecto a su rango de referencia. */
export type RangeFlag = 'normal' | 'high' | 'low' | 'critical-high' | 'critical-low' | 'unknown';

export interface ChartObservationPoint {
  /** ISO-8601 o fecha suelta, tal como venga en `effectiveDateTime`. */
  at: string;
  value: number;
  flag: RangeFlag;
}

/**
 * Una magnitud clínica con su historia. Agrupa todas las `Observation` del mismo
 * código LOINC para el mismo paciente, ordenadas de la más antigua a la más nueva.
 */
export interface ChartMetric {
  /** Clave estable para el componente, p. ej. `hba1c` o `bp-systolic`. */
  key: string;
  label: string;
  loinc: string | null;
  unit: string;
  /** Ordenados por fecha ascendente. Puede tener un solo punto. */
  points: ChartObservationPoint[];
  /** El más reciente, o `null` si la serie está vacía. */
  latest: ChartObservationPoint | null;
  /** Rango de referencia aplicado. `null` si no se conoce uno para este analito. */
  referenceRange: ReferenceRange | null;
  /** Dirección de la serie. `null` con menos de dos puntos: no hay tendencia. */
  trend: MetricTrend | null;
}

export interface ReferenceRange {
  low: number | null;
  high: number | null;
  /** Umbral por encima del cual el valor es alarmante, no solo alto. */
  criticalHigh: number | null;
  criticalLow: number | null;
  /** De dónde sale el rango. Se muestra al médico: un rango sin fuente no se cree. */
  source: string;
  /** `true` cuando un valor MÁS BAJO es peor (p. ej. FEV1), al revés de lo habitual. */
  lowerIsWorse: boolean;
}

export interface MetricTrend {
  /** Diferencia entre el último punto y el anterior. */
  delta: number;
  /** Diferencia entre el último punto y el primero de la serie. */
  deltaFromFirst: number;
  direction: 'rising' | 'falling' | 'flat';
  /**
   * Interpretación CLÍNICA de la dirección, que no siempre coincide con "sube".
   * Un FEV1 que sube es bueno; una HbA1c que sube es mala. Lo decide
   * `referenceRange.lowerIsWorse`, no el signo del delta.
   */
  clinical: 'improving' | 'worsening' | 'stable' | 'unknown';
  /** Días entre el primer y el último punto. Contextualiza la magnitud del cambio. */
  spanDays: number | null;
}

/* ================================================================== */
/* Notas, órdenes, equipo y agenda                                     */
/* ================================================================== */

export interface ChartNote {
  id: string;
  title: string;
  /** Tipo del documento, p. ej. "Química sanguínea". */
  category: string | null;
  date: string | null;
  author: string | null;
  /** Texto embebido, si el adjunto trae `data`. `null` si solo hay una URL. */
  text: string | null;
  /**
   * URL del adjunto tal como viene. Puede ser relativa e irresoluble —en el
   * dataset real lo es— y por eso `attachmentResolvable` lo dice explícitamente
   * en vez de dejar que la UI ofrezca un enlace que va a fallar.
   */
  attachmentUrl: string | null;
  attachmentResolvable: boolean;
  status: string | null;
}

export interface ChartOrder {
  id: string;
  display: string;
  code: string | null;
  category: string | null;
  status: string | null;
  intent: string | null;
  authoredOn: string | null;
  requester: string | null;
  note: string | null;
}

export interface ChartCareTeamMember {
  id: string;
  name: string;
  role: string | null;
}

export interface ChartAppointment {
  id: string;
  patientId: string;
  /** Motivo de la cita. En este dataset es donde vive la pista clínica. */
  description: string | null;
  start: string | null;
  end: string | null;
  status: string | null;
  /** Clínico que atiende, tomado del participante que no es el paciente. */
  practitioner: string | null;
}

/* ================================================================== */
/* Agregados                                                           */
/* ================================================================== */

/**
 * Todo lo que necesita la página de expediente de un paciente. Se arma con una
 * sola tanda de lecturas en paralelo para que la pantalla no se pinte a trozos.
 */
export interface PatientChart {
  patient: ChartPatient;
  conditions: ChartCondition[];
  allergies: ChartAllergy[];
  medications: ChartMedication[];
  metrics: ChartMetric[];
  notes: ChartNote[];
  orders: ChartOrder[];
  careTeam: ChartCareTeamMember[];
  appointments: ChartAppointment[];
}

/**
 * Una fila del roster. Lleva ya calculado lo necesario para triar de un vistazo,
 * porque obligar al médico a abrir tres expedientes para saber cuál urge es
 * exactamente el trabajo que esta pantalla debería quitarle.
 */
export interface RosterEntry {
  patient: ChartPatient;
  /** Próxima cita futura, o la más reciente si no hay ninguna futura. */
  nextAppointment: ChartAppointment | null;
  /** Condiciones activas, para la línea de resumen. */
  activeConditions: string[];
  activeMedicationCount: number;
  /** Métrica que define el estado del paciente hoy (la de peor señal). */
  headlineMetric: ChartMetric | null;
  /** Señales que merecen atención, ya ordenadas por severidad. */
  flags: ChartFlag[];
}

export type FlagSeverity = 'danger' | 'warn' | 'info';

/**
 * Una señal calculada de forma DETERMINISTA a partir de los datos.
 *
 * Nunca la genera un modelo: cada bandera nace de una comparación aritmética
 * explícita en `insights.ts`, y `basis` guarda el porqué en texto para que el
 * médico pueda auditar la afirmación en vez de tener que confiar en ella.
 */
export interface ChartFlag {
  id: string;
  severity: FlagSeverity;
  title: string;
  /** La evidencia concreta: los números que produjeron la bandera. */
  basis: string;
}
