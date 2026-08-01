/**
 * Escrituras del expediente — SOLO SERVIDOR.
 *
 * El gemelo de `read.ts`, y con la regla opuesta en lo único que importa:
 *
 * **una escritura NUNCA degrada a fixture.** Una lectura que falla puede caer al
 * respaldo y decirlo con un badge; una escritura que "cae al respaldo" sería
 * enseñar un paciente que no existe en ningún servidor. Quien lo diera de alta
 * se iría convencido de haberlo registrado, y el paciente no estaría. Por eso
 * aquí el fallo se propaga hasta la pantalla con su motivo, siempre.
 *
 * Lo que sí se conserva de `read.ts` es que **nada lanza**: el fallo viaja como
 * valor de retorno, no como excepción. Un error boundary encima de un formulario
 * pierde lo que el usuario había escrito, y volver a teclear una ficha entera
 * porque el wifi parpadeó es exactamente el momento en que se abandona la app.
 */

import 'server-only';

import type { Patient } from '@medplum/fhirtypes';

import { medplumConfigured, medplumWriteClient } from '../medplum/server';
import { buildPatientResource, displayNameOf, type NewPatientInput } from './new-patient';

/**
 * Tope de espera para un alta.
 *
 * Más generoso que los 4 s de lectura a propósito: un `POST` a Medplum indexa,
 * valida contra el perfil y escribe historia, y rendirse pronto en una escritura
 * no ahorra nada — el paciente ya está a mitad de camino.
 */
export const MEDPLUM_WRITE_TIMEOUT_MS = 8000;

export type WriteOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; detail: string | null };

/* ================================================================== */

class WriteTimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'WriteTimeoutError';
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Traduce el fallo de Medplum a algo accionable en español.
 *
 * Se distinguen los casos porque el remedio es distinto en cada uno, y un
 * "error al crear el paciente" genérico obliga a abrir la consola para saber si
 * hay que arreglar el `.env`, esperar, o llamar a alguien.
 */
function describeWriteError(error: unknown): { message: string; detail: string | null } {
  if (error instanceof WriteTimeoutError) {
    // El aviso de duplicado no es paranoia: un timeout NO significa que la
    // escritura fallara, solo que no llegó la respuesta. El `POST` puede haber
    // aterrizado igual, y reintentar a ciegas crea dos veces al mismo paciente.
    return {
      message: `Medplum no respondió en ${MEDPLUM_WRITE_TIMEOUT_MS / 1000} s. Puede que el alta sí se haya guardado: recarga la agenda antes de volver a intentarlo.`,
      detail: null,
    };
  }

  const raw = messageOf(error);

  if (/forbidden|not allowed|access denied|403/i.test(raw)) {
    return {
      message: 'Medplum rechazó el alta: estas credenciales no tienen permiso de escritura sobre Patient.',
      detail: raw,
    };
  }

  if (/invalid|unauthorized|401/i.test(raw)) {
    return {
      message: 'No se pudo autenticar con Medplum. Revisa MEDPLUM_CLIENT_ID y MEDPLUM_CLIENT_SECRET.',
      detail: raw,
    };
  }

  return { message: 'No se pudo guardar el paciente en Medplum.', detail: raw };
}

/* ================================================================== */
/* Alta de paciente                                                    */
/* ================================================================== */

export interface CreatedPatient {
  id: string;
  displayName: string;
}

/**
 * Crea un `Patient` en Medplum a partir de la entrada ya validada.
 *
 * Recibe la entrada validada y no el `FormData` crudo para que sea imposible
 * llamar a esto sin haber pasado por `parsePatientForm`: el tipo es la garantía
 * de que a Medplum no le llega un `birthDate` que no existe en el calendario.
 */
export async function createPatient(input: NewPatientInput): Promise<WriteOutcome<CreatedPatient>> {
  if (!medplumConfigured) {
    // Sin credenciales el expediente LEE fixtures, pero no puede escribir en
    // ningún sitio. Se dice tal cual en vez de fingir un alta local que
    // desaparecería en la siguiente recarga.
    return {
      ok: false,
      message: 'Medplum no está configurado: sin MEDPLUM_CLIENT_ID y MEDPLUM_CLIENT_SECRET no se puede dar de alta a nadie.',
      detail: null,
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const medplum = await medplumWriteClient();
    const resource = buildPatientResource(input);

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WriteTimeoutError()), MEDPLUM_WRITE_TIMEOUT_MS);
    });

    const created = await Promise.race([medplum.createResource<Patient>(resource), timeout]);

    // Medplum siempre devuelve `id` en un 201, pero el tipo lo declara opcional
    // y de ese id cuelga el enlace al expediente. Si faltara, el alta habría
    // funcionado y el enlace llevaría a un 404: mejor decirlo aquí.
    if (!created.id) {
      return {
        ok: false,
        message: 'Medplum guardó el paciente pero no devolvió su identificador. Recarga la agenda para verlo.',
        detail: null,
      };
    }

    return {
      ok: true,
      value: { id: created.id, displayName: displayNameOf(input) },
    };
  } catch (error) {
    const { message, detail } = describeWriteError(error);
    // Queda en el log del servidor con el error íntegro: la pantalla enseña la
    // versión corta y quien depura necesita la larga.
    console.error('[loop-dashboard] alta de paciente fallida:', error);
    return { ok: false, message, detail };
  } finally {
    clearTimeout(timer);
  }
}
