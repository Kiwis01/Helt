/**
 * Qué paciente del expediente está enrolado en Loop — SOLO SERVIDOR.
 *
 * Loop no es una pestaña aparte: es una sección más del expediente, y aparece
 * únicamente en el paciente que de verdad usa el compañero de voz. Esa
 * distinción no es cosmética. Las series de biometría, los episodios y los
 * outcomes salen de loop-core y describen a UN paciente; pintarlas bajo el
 * nombre de cualquier otro sería atribuirle a Emily Carter los latidos de otra
 * persona, que es justo la clase de mentira que el resto del dashboard se
 * esfuerza en no contar.
 *
 * En este proyecto de Medplum el enrolado es Carlos Quihuis, y encaja porque su
 * expediente real ya tiene el cuadro que Loop atiende: trastorno de ansiedad
 * activo (SNOMED 197480006) y sertralina 50 mg (RxNorm 312938).
 *
 * El UUID vive aquí y no en `config.ts` porque nunca llega al navegador: todo
 * lo que lo consume se renderiza en el servidor. Se puede anular por entorno
 * para apuntar a otro proyecto sin tocar código, y el MRN queda escrito al lado
 * para reencontrar al paciente si el proyecto se recrea desde cero.
 */

import 'server-only';

export const LOOP_MEDPLUM_PATIENT_ID =
  (process.env.LOOP_MEDPLUM_PATIENT_ID ?? '').trim() || 'c4543320-0d0b-42ae-a2c5-02efc7901790';

/** MRN del mismo paciente en este proyecto. Documental: nada lo consume. */
export const LOOP_MEDPLUM_PATIENT_MRN = 'LOOP-CQ-0001';

/** ¿El expediente que se está abriendo es el del paciente enrolado en Loop? */
export function isLoopPatient(patientId: string): boolean {
  return patientId === LOOP_MEDPLUM_PATIENT_ID;
}
