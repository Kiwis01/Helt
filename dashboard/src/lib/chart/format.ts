/**
 * Formateo de fechas del expediente.
 *
 * Dos decisiones que parecen detalles y no lo son:
 *
 * 1. **La hora se muestra en la zona en la que se registró el dato**, no en UTC
 *    ni en la del navegador. Una cita guardada como `2026-08-07T10:30:00-07:00`
 *    es la consulta de las 10:30 en la clínica; pintarla como "17:30" porque el
 *    servidor piensa en UTC es dar una hora que no existe para nadie. Se extrae
 *    el desfase del propio texto ISO y se desplaza el instante, en vez de
 *    codificar a mano una zona que mañana cambia.
 *
 * 2. **Todo se formatea con `timeZone: 'UTC'` DESPUÉS de ese desplazamiento.**
 *    El expediente se pinta en el servidor y algunos paneles se rehidratan en el
 *    cliente; sin una zona fija, la misma fecha saldría distinta en cada lado y
 *    React marcaría un error de hidratación en mitad del demo.
 *
 * Nada de aquí lanza: una fecha inválida devuelve un guion.
 */

export const EMPTY = '—';

const MINUTE_MS = 60_000;

/** Desfase horario del propio texto ISO, en minutos. `null` si no lo lleva. */
function offsetMinutesOf(iso: string): number | null {
  if (/[zZ]$/.test(iso)) return 0;
  const match = /([+-])(\d{2}):?(\d{2})$/.exec(iso);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * Instante desplazado para que, formateado como UTC, muestre la hora de pared
 * de la zona original.
 */
function wallClock(iso: string): Date | null {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  const offset = offsetMinutesOf(iso);
  // Sin desfase (una fecha suelta como "2026-07-21") `Date.parse` ya la trata
  // como UTC, así que no hay nada que desplazar.
  return new Date(offset === null ? parsed : parsed + offset * MINUTE_MS);
}

const FORMATTERS = {
  date: new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }),
  dateShort: new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }),
  dateTime: new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }),
  time: new Intl.DateTimeFormat('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }),
};

function format(iso: string | null | undefined, key: keyof typeof FORMATTERS): string {
  if (!iso) return EMPTY;
  const date = wallClock(iso);
  return date ? FORMATTERS[key].format(date) : EMPTY;
}

/** "21 jul 2026" */
export function formatDate(iso: string | null | undefined): string {
  return format(iso, 'date');
}

/** "21 jul" */
export function formatDateShort(iso: string | null | undefined): string {
  return format(iso, 'dateShort');
}

/** "7 ago, 10:30" — en la hora de la clínica, no en UTC. */
export function formatDateTime(iso: string | null | undefined): string {
  return format(iso, 'dateTime');
}

/** "10:30" */
export function formatTime(iso: string | null | undefined): string {
  return format(iso, 'time');
}

const DAY_MS = 86_400_000;

/**
 * Distancia en días respecto a `now`, en lenguaje natural.
 * Sirve tanto para el pasado ("hace 4 días") como para el futuro ("en 6 días"),
 * porque la agenda mezcla citas cumplidas y pendientes.
 */
export function formatRelativeDays(iso: string | null | undefined, now: number): string {
  if (!iso) return EMPTY;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return EMPTY;

  const days = Math.round((parsed - now) / DAY_MS);
  if (days === 0) return 'hoy';
  if (days === 1) return 'mañana';
  if (days === -1) return 'ayer';
  return days > 0 ? `en ${days} días` : `hace ${Math.abs(days)} días`;
}

/** Años cumplidos como texto, o el motivo de que falte. */
export function formatAge(age: number | null): string {
  return age === null ? 'Edad no registrada' : `${age} años`;
}

export function describeGender(gender: string | null): string {
  switch (gender) {
    case 'female':
      return 'Mujer';
    case 'male':
      return 'Hombre';
    case 'other':
      return 'Otro';
    default:
      return 'Sexo no registrado';
  }
}
