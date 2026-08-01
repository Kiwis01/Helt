/**
 * Validación de los eventos del stream de loop-voice — Contrato 5.
 *
 * El SSE llega de otro servicio, escrito por otra persona, mientras hay una
 * llamada en curso delante de un jurado. La regla es simple: un evento que no
 * valida contra `LiveEvent` se descarta y se cuenta, nunca entra al estado.
 * Un `text` que llega como número o un `rule` ausente romperían el render en
 * mitad del pitch, y una pantalla en blanco es peor que un evento perdido.
 *
 * El modo replay pasa por esta misma puerta a propósito: si el guión de
 * `demo-call.ts` se desviara del contrato, fallaría aquí y no en el escenario.
 */

import { LiveEvent, LiveEventName } from '@loop/shared/contracts';

/** Los 7 nombres del Contrato 5, tal como vienen del enum compartido. */
export const LIVE_EVENT_NAMES = LiveEventName.options;

/** Valida el sobre `{ event, data }` completo. Devuelve null si no cumple. */
export function parseLiveEnvelope(envelope: unknown): LiveEvent | null {
  const parsed = LiveEvent.safeParse(envelope);
  if (parsed.success) return parsed.data;

  console.warn('[loop] evento descartado: no cumple el Contrato 5', {
    issues: parsed.error.issues,
    envelope,
  });
  return null;
}

/** Un mensaje SSE crudo: el nombre viene del campo `event:` y el payload del `data:`. */
export function parseSseMessage(name: string, raw: unknown): LiveEvent | null {
  if (typeof raw !== 'string') {
    console.warn('[loop] evento descartado: el payload SSE no es texto', { name, raw });
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    console.warn('[loop] evento descartado: el payload SSE no es JSON', { name, raw });
    return null;
  }

  return parseLiveEnvelope({ event: name, data });
}
