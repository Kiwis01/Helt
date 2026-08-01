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
 * - SIN CUERPO ES UN ESTADO VÁLIDO. Un panel que todavía no tiene nada que
 *   decir se encoge a su encabezado —una sola línea— en vez de reservar un
 *   rectángulo vacío. En una rejilla de altura fija el hueco que no gasta uno
 *   se lo queda el vecino, así que "vacío" no puede costar lo mismo que
 *   "lleno". La píldora del encabezado sigue contando el estado.
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
  /** Omitido o nulo: la tarjeta se queda en su encabezado, alta de una línea. */
  children?: ReactNode;
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
  // `null` y `false` son cuerpos vacíos de verdad —salen de un `cond ? x : null`
  // en quien llama—, así que la tarjeta se colapsa igual que si no le hubieran
  // pasado hijos. Un `0` sí es contenido y no entra aquí.
  const hasBody = children !== null && children !== undefined && children !== false;

  return (
    <section
      style={{ '--i': index } as CSSProperties}
      className={`glass bloom flex min-h-0 min-w-0 flex-col rounded-card ${className ?? ''}`}
    >
      {/* Sin cuerpo el encabezado reparte su aire arriba y abajo: con `pb-3
          pt-4` la única línea de la tarjeta quedaría descentrada 4px, que a
          esta escala se ve como un panel mal cortado. */}
      <header
        className={`flex shrink-0 items-center justify-between gap-3 px-5 ${
          hasBody ? 'pb-3 pt-4' : 'py-3.5'
        }`}
      >
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="label truncate">{title}</h2>
          {subtitle ? <p className="truncate text-2xs text-ink-3">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </header>

      {hasBody ? (
        <div className={`min-h-0 flex-1 ${bodyClassName ?? 'px-5 pb-5'}`}>{children}</div>
      ) : null}
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
