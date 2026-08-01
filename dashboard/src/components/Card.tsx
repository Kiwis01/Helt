import type { CSSProperties, ReactNode } from 'react';

/**
 * Widget de vidrio. Todo panel de la página es uno de estos.
 *
 * Reglas de contenido que el primitivo hace cumplir por su forma:
 *
 * - El título es una ETIQUETA, no un titular: pequeño y callado, en el
 *   peldaño más bajo de la escalera de texto. Lo que debe destacar es el
 *   dato, no el nombre del panel.
 * - `subtitle` es para una unidad o una ventana ("30 days", "bpm"). No para
 *   explicar el panel. Si necesita explicación, está mal diseñado.
 * - El cuerpo lleva `min-h-0` y hace scroll propio: el layout es una rejilla
 *   de altura fija (1280x720, sin scroll de página), así que un panel que
 *   crece se desborda dentro de sí mismo, nunca empuja a los vecinos.
 */
interface CardProps {
  /** Etiqueta corta. Dos o tres palabras, no una frase. */
  title: string;
  /** Solo unidad, ventana o fuente. Nunca una explicación. */
  subtitle?: string;
  /** Controles del encabezado: selectores, píldoras de estado. */
  actions?: ReactNode;
  /** Orden de entrada para escalonar el bloom. */
  index?: number;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function Card({
  title,
  subtitle,
  actions,
  index = 0,
  className,
  bodyClassName,
  children,
}: CardProps) {
  return (
    <section
      style={{ '--i': index } as CSSProperties}
      className={`glass bloom flex min-h-0 min-w-0 flex-col rounded-card ${className ?? ''}`}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 px-5 pb-3 pt-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="label truncate">{title}</h2>
          {subtitle ? <p className="truncate text-2xs text-ink-3">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </header>

      <div className={`min-h-0 flex-1 ${bodyClassName ?? 'px-5 pb-5'}`}>{children}</div>
    </section>
  );
}

/**
 * Estado vacío.
 *
 * Una línea. No dos, no una lista de viñetas. Un panel vacío que necesita un
 * párrafo para justificarse se lee como roto — y esta pantalla se proyecta.
 */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center">
      <span
        aria-hidden
        className="h-px w-8 bg-gradient-to-r from-transparent via-[var(--accent)] to-transparent opacity-60"
      />
      <p className="max-w-[26ch] text-sm leading-snug text-ink-3">{children}</p>
    </div>
  );
}
