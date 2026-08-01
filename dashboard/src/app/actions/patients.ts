'use server';

/**
 * Acciones de servidor del roster.
 *
 * Un Server Action y no una ruta `/api`: el formulario postea directamente al
 * servidor, así que `MEDPLUM_CLIENT_SECRET` nunca tiene que existir en ningún
 * sitio al que el navegador pueda llegar, ni siquiera detrás de un endpoint
 * propio. No hay `fetch` en el cliente, no hay endpoint que proteger y no hay
 * un JSON de credenciales que se pueda filtrar por descuido.
 *
 * Este archivo solo pega piezas: validar (`new-patient.ts`), escribir
 * (`write.ts`) y refrescar la agenda. La lógica vive en esos módulos, que se
 * pueden probar sin levantar Next.
 */

import { revalidatePath } from 'next/cache';

import { parsePatientForm, type NewPatientState } from '@/lib/chart/new-patient';
import { createPatient } from '@/lib/chart/write';

/**
 * Da de alta un paciente en Medplum.
 *
 * La firma `(estadoPrevio, formData)` es la que espera `useActionState` de
 * React 19. El estado previo no se usa: cada intento se juzga por sí solo, y
 * arrastrar el error del intento anterior solo sirve para enseñar un mensaje
 * que ya no es cierto.
 */
export async function createPatientAction(
  _previous: NewPatientState,
  formData: FormData,
): Promise<NewPatientState> {
  const parsed = parsePatientForm(formData);
  if (!parsed.ok) {
    return { status: 'invalid', fieldErrors: parsed.fieldErrors, values: parsed.raw };
  }

  const outcome = await createPatient(parsed.value);
  if (!outcome.ok) {
    // Lo escrito vuelve con el error. Si Medplum estaba caído, el remedio es
    // pulsar otra vez, no volver a teclear la ficha entera.
    return { status: 'failed', message: outcome.message, detail: outcome.detail, values: parsed.raw };
  }

  // La agenda es `force-dynamic`, así que se recalcula en cada visita; esto es
  // para que la pestaña que YA está abierta vea al paciente nuevo sin que nadie
  // tenga que recargar a mano delante del jurado.
  revalidatePath('/');

  return {
    status: 'created',
    id: outcome.value.id,
    displayName: outcome.value.displayName,
  };
}
