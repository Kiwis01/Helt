import { redirect } from 'next/navigation';

import { LOOP_MEDPLUM_PATIENT_ID } from '@/lib/medplum/loop-patient';

/**
 * `/loop` ya no es una vista: Loop vive dentro del expediente del paciente
 * enrolado, en `/paciente/[id]`.
 *
 * La ruta sobrevive como redirección y no se borra porque durante el hackathon
 * este enlace se pegó en Slack, quedó en marcadores y aparece en las notas del
 * pitch. Un 404 en mitad del demo por una URL que alguien guardó ayer es un
 * precio absurdo por ahorrarse cinco líneas.
 */
export default function LoopRedirectPage() {
  redirect(`/paciente/${LOOP_MEDPLUM_PATIENT_ID}`);
}
