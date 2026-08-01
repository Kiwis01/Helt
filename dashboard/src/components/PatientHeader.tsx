import type { CSSProperties } from 'react';

import type { PatientSummary } from '@loop/shared/contracts';

import { DATA, STAT } from '@/components/tokens';
import { EMPTY, formatDate, formatRelativeDays } from '@/lib/format';

/** El contrato deja `gender` como string libre; aquí solo se traduce. */
const GENDER_LABELS: Record<string, string> = {
  female: 'Mujer',
  male: 'Hombre',
  other: 'Otro',
  unknown: 'No registrado',
};

/**
 * "Alex Rivera" → "AR". Dos letras como máximo: el avatar es un ancla visual,
 * no una segunda copia del nombre que ya está al lado.
 */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return EMPTY;
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return (first + last).toUpperCase();
}

/**
 * Identidad clínica del paciente. Es la primera fila que se lee, así que está
 * ordenada por importancia clínica y no por comodidad de rejilla: quién es
 * (avatar + nombre), qué tiene (condición sobre medicación) y cómo va la cosa
 * (episodios y último).
 *
 * EL ANCLA DE LA FILA ES EL NOMBRE, y es lo único que sube de tamaño. Antes el
 * nombre y el recuento de episodios pesaban exactamente lo mismo (22px los
 * dos), en los dos extremos de la barra: dos anclas del mismo peso en la fila
 * que ordena toda la pantalla. Se resolvió a favor del nombre porque esto es
 * una franja de identidad, no un widget de datos —los cuatro números héroe de
 * la pantalla viven en los paneles de abajo y esta barra no debe competir con
 * ellos—, y el recuento bajó al peldaño de dato que le corresponde.
 *
 * Lo que antes eran seis bloques idénticos de etiqueta+valor+subtexto ahora
 * son tres zonas con pesos distintos. Los metadatos que nadie lee de lejos
 * —RxNorm, fecha de inicio, fecha del care plan, ID del paciente— viven en
 * `title`: siguen ahí para quien los busque, sin ocupar píxeles.
 *
 * Server Component a propósito: no tiene interacción, y así el texto relativo
 * ("ayer") se congela en el HTML y no se desincroniza al hidratar.
 */
export function PatientHeader({ summary }: { summary: PatientSummary }) {
  const now = Date.now();

  const condition =
    summary.conditions.find((c) => c.clinicalStatus === 'active') ?? summary.conditions[0];
  const medication =
    summary.medications.find((m) => m.status === 'active') ?? summary.medications[0];

  const lastEpisode = summary.lastEpisodeAt ? formatRelativeDays(summary.lastEpisodeAt, now) : EMPTY;

  // Un episodio de hoy o de ayer sigue "caliente" para el clínico: se merece
  // el punto de alerta. Se compara contra la salida del propio formateador en
  // vez de repetir aquí la aritmética de días UTC que ya vive en lib/format.
  const episodeIsRecent = lastEpisode === 'hoy' || lastEpisode === 'ayer';

  return (
    <header
      style={{ '--i': 1 } as CSSProperties}
      className="bloom flex shrink-0 items-center gap-4 border-b border-hair px-5 py-3"
    >
      {/* Quién es. */}
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className={`grid size-10 shrink-0 place-items-center rounded-full ${DATA} font-semibold text-ink`}
          style={{
            background: 'linear-gradient(150deg, rgba(127,196,238,0.40), rgba(127,196,238,0.14))',
            border: '1px solid rgba(255,255,255,0.12)',
          }}
        >
          {initialsOf(summary.displayName)}
        </span>

        <div className="min-w-0">
          <h1 className={`${STAT} truncate text-ink`} title={summary.patientId}>
            {summary.displayName}
          </h1>
          <p className="mt-1.5 truncate text-2xs text-ink-3">
            {summary.age} años · {GENDER_LABELS[summary.gender ?? ''] ?? summary.gender ?? EMPTY}
          </p>
        </div>
      </div>

      {/* Qué tiene. La condición pesa más que la medicación: por color dentro
          de la escalera de blancos, no por tamaño —los dos son dato terciario
          y subir uno de peldaño sería inventar un cuarto tamaño. */}
      <div className="min-w-0 flex-1 border-l border-hair pl-4">
        <p
          className={`${DATA} truncate font-semibold text-ink`}
          title={condition ? `Desde ${formatDate(condition.onsetDate)}` : undefined}
        >
          {condition?.display ?? EMPTY}
        </p>
        <p
          className="mt-1.5 truncate text-2xs text-ink-3"
          title={medication ? `RxNorm ${medication.rxnorm}` : undefined}
        >
          {medication?.display ?? 'Sin medicación activa'}
        </p>
      </div>

      {/* Cómo va la cosa. Tesela plana, no otra caja de vidrio, y dos datos del
          mismo peso: cuántos episodios y cuándo fue el último. Lo que avisa de
          que hay algo caliente es el punto de alerta, no el tamaño. */}
      <div className="ml-auto flex shrink-0 items-center gap-4">
        <p
          className="truncate text-2xs text-ink-3"
          title={`Care plan actualizado ${formatDate(summary.carePlanLastUpdated)}`}
        >
          Plan · {summary.carePlanAuthor}
        </p>

        <div className="tile flex items-center gap-4 px-4 py-2">
          <div>
            <p className="label leading-none">Episodios · 30 días</p>
            <p className={`mt-1.5 ${DATA} font-semibold text-ink`}>{summary.episodeCount}</p>
          </div>

          <span aria-hidden className="h-8 w-px shrink-0 bg-hair" />

          <div>
            <p className="label leading-none">Último</p>
            <div className="mt-1.5 flex items-center gap-1.5">
              {episodeIsRecent ? <span aria-hidden className="dot dot-alert" /> : null}
              <span
                className={`${DATA} font-semibold text-ink`}
                title={formatDate(summary.lastEpisodeAt)}
              >
                {lastEpisode}
              </span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
