/**
 * Retroceso tipo iOS: chevron + nombre de a dónde vuelve.
 *
 * No dice "Atrás". Apple rotula el destino porque es lo que el usuario
 * necesita antes de pulsar: "atrás" solo se entiende si recuerdas de dónde
 * viniste, y en una pantalla que alguien ve por primera vez —un juez, en el
 * escenario— eso no se puede dar por supuesto.
 *
 * Es un `Link` real y no un `router.back()`: el destino es fijo y conocido,
 * así que debe ser una URL navegable, abrible en pestaña nueva e indexable
 * por el navegador. `back()` habría dependido de cómo se llegó.
 */

import Link from 'next/link';

interface BackLinkProps {
  href: string;
  /** El nombre de la vista de destino, no un verbo. */
  label: string;
  /** Se anuncia el atajo si la vista lo tiene enganchado. */
  shortcut?: string;
}

export function BackLink({ href, label, shortcut }: BackLinkProps) {
  return (
    <Link
      href={href}
      className="backlink"
      title={shortcut ? `${label} · ${shortcut}` : label}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path
          d="M10 3.5 5.5 8l4.5 4.5"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {label}
    </Link>
  );
}
