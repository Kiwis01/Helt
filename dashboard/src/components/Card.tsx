import type { ReactNode } from 'react';

/**
 * Primitivo de layout. Toda la página son tarjetas de este tipo para que el
 * ritmo vertical y los bordes sean idénticos en los cinco paneles.
 *
 * El cuerpo lleva `min-h-0` + `overflow-hidden` porque el layout es una
 * rejilla de altura fija (1280x720, sin scroll de página): si un panel crece,
 * tiene que hacer scroll dentro de sí mismo, nunca empujar a los vecinos.
 */
interface CardProps {
  title: string;
  /** Contexto corto bajo el título: unidad, ventana temporal, origen. */
  subtitle?: string;
  /** Controles a la derecha del encabezado (selectores, badges). */
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function Card({ title, subtitle, actions, className, bodyClassName, children }: CardProps) {
  return (
    <section
      className={`flex min-h-0 min-w-0 flex-col rounded-card border border-line bg-surface ${className ?? ''}`}
    >
      <header className="flex shrink-0 items-baseline justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 className="truncate text-2xs font-semibold uppercase tracking-[0.12em] text-ink-2">
            {title}
          </h2>
          {subtitle ? <p className="truncate text-2xs text-ink-3">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>

      <div className={`min-h-0 flex-1 overflow-hidden ${bodyClassName ?? 'p-4'}`}>{children}</div>
    </section>
  );
}

interface CardPlaceholderProps {
  /** Qué va a ocupar este hueco. Se lee desde el fondo de la sala. */
  label: string;
  /** Una línea de contexto: qué datos ya están disponibles para pintarlo. */
  note?: string;
  /** Requisitos concretos que hereda el siguiente agente. */
  requirements?: readonly string[];
}

/**
 * Hueco reservado para un componente que aún no existe.
 *
 * Se ve deliberado —trama diagonal, etiqueta clara, datos ya cargados a la
 * vista— porque un panel vacío sin explicar es indistinguible de un panel
 * roto, y esta pantalla se proyecta.
 */
export function CardPlaceholder({ label, note, requirements }: CardPlaceholderProps) {
  return (
    <div className="placeholder-hatch flex h-full min-h-0 flex-col justify-center gap-2 rounded-md border border-dashed border-line-strong px-5 py-4">
      <p className="text-sm font-medium text-ink-2">{label}</p>
      {note ? <p className="text-xs text-ink-3">{note}</p> : null}
      {requirements && requirements.length > 0 ? (
        <ul className="mt-0.5 space-y-1">
          {requirements.map((item) => (
            <li key={item} className="flex gap-2 text-xs leading-snug text-ink-3">
              <span aria-hidden className="text-line-strong">
                ·
              </span>
              <span className="min-w-0">{item}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
