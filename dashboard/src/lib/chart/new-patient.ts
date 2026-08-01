/**
 * Alta de paciente — validación y construcción del recurso FHIR.
 *
 * Este módulo NO habla con la red y NO es `server-only` a propósito: la misma
 * validación corre en el navegador (para enseñar el error mientras se escribe)
 * y en el servidor (que es la única que cuenta). Un formulario que solo valida
 * en el cliente es un formulario sin validar.
 *
 * Regla heredada de `types.ts`: **lo ausente se representa, no se inventa.**
 * Aquí eso significa que un campo vacío del formulario NO viaja a Medplum como
 * cadena vacía ni como un valor por defecto plausible — el campo sencillamente
 * no existe en el recurso. Un `birthDate: ""` en FHIR es un dato corrupto; un
 * `birthDate` ausente es la verdad: no lo sabemos todavía.
 *
 * Por eso todos los campos son `string` y `''` significa "no lo sé": es lo que
 * llega literalmente de un `<input>` vacío, y traducirlo a `undefined` a mitad
 * de camino solo añade un estado más donde equivocarse.
 */

import type { Patient } from '@medplum/fhirtypes';
import { z } from 'zod';

/* ================================================================== */
/* Vocabulario del proyecto                                            */
/* ================================================================== */

/**
 * Sistema de identificadores de este proyecto de Medplum.
 *
 * No es inventado: es el que ya llevan los pacientes reales del expediente
 * (`teachback-sofia` y compañía). Usar otro haría que el MRN de los pacientes
 * nuevos no fuera comparable con el de los que ya están.
 */
export const IDENTIFIER_SYSTEM = 'https://teachback.demo/id';

/** Los cuatro valores de `Patient.gender` en FHIR R4. No hay más. */
export const GENDERS = [
  { code: 'female', label: 'Femenino' },
  { code: 'male', label: 'Masculino' },
  { code: 'other', label: 'Otro' },
  { code: 'unknown', label: 'Sin especificar' },
] as const;

/**
 * Idioma preferido para hablar con el paciente.
 *
 * Importa de verdad y no es decorativo: Loop llama por teléfono, y el idioma
 * del recurso es lo que decide en qué habla el agente. Por eso es un campo del
 * formulario y no una constante escondida.
 */
export const LANGUAGES = [
  { code: 'es-MX', label: 'Español (México)' },
  { code: 'en-US', label: 'Inglés (EE. UU.)' },
] as const;

const GENDER_CODES = GENDERS.map((g) => g.code) as [string, ...string[]];
const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as [string, ...string[]];

/* ================================================================== */
/* Validación                                                          */
/* ================================================================== */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ¿Existe esa fecha en el calendario?
 *
 * `new Date('2026-02-31')` no lanza: desborda a marzo. La única forma fiable de
 * detectarlo es reconstruir el texto desde el `Date` resultante y comparar.
 */
function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Hoy en UTC.
 *
 * Se compara en UTC —y no en la zona del navegador— porque esta validación
 * corre en los dos lados: si cada uno usara su propio reloj, una fecha podría
 * pasar en el cliente y ser rechazada por el servidor, que es la peor clase de
 * error de formulario (el usuario ve un error sobre un campo que ve correcto).
 * El precio es un día de holgura en el borde, y el borde es "nacido hoy".
 */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Un teléfono utilizable: al menos 8 dígitos, con la puntuación que sea. */
const PHONE_DIGITS = /\d/g;

/**
 * Esquema del formulario de alta.
 *
 * Solo dos campos son obligatorios —nombre y apellidos— porque son los únicos
 * sin los cuales la ficha no sirve para nada: un paciente sin nombre no se
 * puede llamar por su nombre. Todo lo demás se puede completar después, y
 * exigirlo aquí solo empujaría a quien da de alta a rellenarlo con basura.
 */
export const newPatientSchema = z.object({
  given: z
    .string()
    .trim()
    .min(1, 'El nombre es obligatorio')
    .max(70, 'El nombre es demasiado largo'),

  family: z
    .string()
    .trim()
    .min(1, 'Los apellidos son obligatorios')
    .max(70, 'Los apellidos son demasiado largos'),

  birthDate: z
    .string()
    .trim()
    .refine((v) => v === '' || ISO_DATE.test(v), 'Usa el formato AAAA-MM-DD')
    .refine((v) => v === '' || isRealDate(v), 'Esa fecha no existe en el calendario')
    .refine((v) => v === '' || v <= todayUtc(), 'La fecha de nacimiento no puede estar en el futuro')
    .refine((v) => v === '' || v >= '1900-01-01', 'La fecha es demasiado antigua'),

  gender: z.enum(GENDER_CODES).describe('Patient.gender'),

  identifier: z
    .string()
    .trim()
    .max(64, 'El identificador es demasiado largo')
    .refine((v) => !/\s/.test(v), 'El identificador no puede llevar espacios'),

  phone: z
    .string()
    .trim()
    .max(32, 'El teléfono es demasiado largo')
    .refine(
      (v) => v === '' || (v.match(PHONE_DIGITS) ?? []).length >= 8,
      'Un teléfono necesita al menos 8 dígitos',
    ),

  language: z.enum(LANGUAGE_CODES),
});

export type NewPatientInput = z.infer<typeof newPatientSchema>;

/** Campos del formulario, para tipar el mapa de errores sin repetir la lista. */
export type NewPatientField = keyof NewPatientInput;

/**
 * Lo que el usuario escribió, TAL CUAL, sin validar.
 *
 * Existe separado de `NewPatientInput` porque lo que se devuelve al formulario
 * tras un error es precisamente el texto que NO pasó la validación: una fecha
 * de 2030 no es un `NewPatientInput`, pero es exactamente lo que hay que volver
 * a pintar en el campo para que se pueda corregir.
 */
export type NewPatientValues = Record<NewPatientField, string>;

/** Lo que se manda cuando el formulario se abre por primera vez. */
export const EMPTY_PATIENT_FORM: NewPatientValues = {
  given: '',
  family: '',
  birthDate: '',
  gender: 'unknown',
  identifier: '',
  phone: '',
  language: 'es-MX',
};

/** Los campos del formulario, en el orden en que se declararon. */
const FIELDS = Object.keys(EMPTY_PATIENT_FORM) as NewPatientField[];

/** `FormData` → los siete campos como texto, sin juzgarlos todavía. */
function rawValues(formData: FormData): NewPatientValues {
  const values = { ...EMPTY_PATIENT_FORM };
  for (const field of FIELDS) {
    const value = formData.get(field);
    values[field] = typeof value === 'string' ? value : '';
  }
  return values;
}

/**
 * `FormData` → entrada validada.
 *
 * Devuelve los errores por campo en vez de lanzar: el formulario los pinta
 * junto a cada `<input>`, que es donde el usuario puede hacer algo con ellos.
 *
 * `raw` viaja SIEMPRE, también cuando la validación pasa. React reinicia un
 * formulario tras ejecutar su acción de servidor, así que sin devolver lo
 * escrito, un error de un solo campo borraría la ficha entera y habría que
 * teclearla de nuevo. Eso no es un detalle de pulido: es el momento exacto en
 * que alguien deja de usar la pantalla.
 */
export function parsePatientForm(
  formData: FormData,
):
  | { ok: true; value: NewPatientInput; raw: NewPatientValues }
  | { ok: false; fieldErrors: Partial<Record<NewPatientField, string>>; raw: NewPatientValues } {
  const raw = rawValues(formData);
  const result = newPatientSchema.safeParse(raw);

  if (result.success) {
    return { ok: true, value: result.data, raw };
  }

  // Solo el PRIMER error de cada campo. Enseñar tres mensajes sobre el mismo
  // input no ayuda a corregirlo; el primero ya dice qué está mal.
  const fieldErrors: Partial<Record<NewPatientField, string>> = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] as NewPatientField | undefined;
    if (field && !fieldErrors[field]) {
      fieldErrors[field] = issue.message;
    }
  }
  return { ok: false, fieldErrors, raw };
}

/* ================================================================== */
/* Construcción del recurso FHIR                                       */
/* ================================================================== */

/**
 * Nombres de pila separados.
 *
 * FHIR guarda `given` como lista porque "María José" son DOS nombres de pila,
 * no uno con espacio. `humanName()` en `map.ts` los vuelve a unir con espacios
 * al pintarlos, así que el viaje de ida y vuelta es fiel.
 */
function splitGiven(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

/**
 * Entrada validada → `Patient` de FHIR R4.
 *
 * Cada campo vacío se OMITE en vez de escribirse en blanco. La diferencia no es
 * estética: `mapPatient()` distingue "ausente" de "vacío" para decidir si pinta
 * un guion o un dato, y el resto del expediente cuenta con esa distinción.
 */
export function buildPatientResource(input: NewPatientInput): Patient {
  const patient: Patient = {
    resourceType: 'Patient',
    // Explícito aunque FHIR asuma activo por omisión: el roster filtra por este
    // campo, y depender de un valor implícito para aparecer en la agenda es
    // frágil de más para el recurso que justo acabas de crear.
    active: true,
    name: [
      {
        use: 'official',
        given: splitGiven(input.given),
        family: input.family,
      },
    ],
    gender: input.gender as Patient['gender'],
    // El idioma siempre viaja: el select tiene valor por defecto, así que aquí
    // nunca hay un hueco que rellenar a ciegas.
    communication: [
      {
        language: { coding: [{ system: 'urn:ietf:bcp:47', code: input.language }] },
        preferred: true,
      },
    ],
  };

  if (input.birthDate !== '') {
    patient.birthDate = input.birthDate;
  }

  if (input.identifier !== '') {
    patient.identifier = [{ system: IDENTIFIER_SYSTEM, value: input.identifier }];
  }

  if (input.phone !== '') {
    patient.telecom = [{ system: 'phone', value: input.phone, use: 'mobile' }];
  }

  return patient;
}

/** Nombre completo tal como lo va a leer el roster, para confirmar el alta. */
export function displayNameOf(input: NewPatientInput): string {
  return [splitGiven(input.given).join(' '), input.family].filter(Boolean).join(' ');
}

/* ================================================================== */
/* Estado del formulario                                               */
/* ================================================================== */

/**
 * Resultado de un intento de alta, tal como lo consume el diálogo.
 *
 * Es una unión discriminada y no un objeto con banderas sueltas porque los
 * cuatro estados son excluyentes: no existe un alta que sea a la vez un éxito y
 * un error de validación, y el tipo lo impide en vez de confiar en que nadie lo
 * escriba.
 *
 * Los dos estados de fallo llevan `values` y el de éxito no, y esa asimetría es
 * intencionada: tras un fallo hay que repintar lo escrito para poder
 * corregirlo, y tras un éxito el formulario ya no existe.
 */
export type NewPatientState =
  | { status: 'idle' }
  | { status: 'created'; id: string; displayName: string }
  | {
      status: 'invalid';
      fieldErrors: Partial<Record<NewPatientField, string>>;
      values: NewPatientValues;
    }
  | { status: 'failed'; message: string; detail: string | null; values: NewPatientValues };

export const IDLE_STATE: NewPatientState = { status: 'idle' };

/** Lo que debe pintarse en los campos: lo último escrito, o el formulario vacío. */
export function valuesOf(state: NewPatientState): NewPatientValues {
  return state.status === 'invalid' || state.status === 'failed' ? state.values : EMPTY_PATIENT_FORM;
}
