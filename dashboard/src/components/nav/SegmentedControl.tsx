'use client';

/**
 * Control segmentado tipo iOS: un riel, una pastilla que se desliza.
 *
 * Sirve para dos cosas distintas a propósito —cambiar de vista en la barra
 * superior y cambiar de métrica dentro de una tarjeta— porque en ambos casos
 * el gesto mental es el mismo: elegir UNO de un conjunto pequeño, cerrado y
 * visible entero. Reutilizar el mismo objeto para el mismo gesto es lo que
 * hace que una interfaz se sienta de una pieza.
 *
 * ## Por qué columnas de igual ancho
 *
 * `UISegmentedControl` las usa, y aquí además resuelven un problema real: con
 * anchos iguales el indicador se coloca con `translateX(i * 100%)` sobre su
 * propio ancho, sin medir nada del DOM. La alternativa —medir cada botón con
 * refs— obliga a un primer pintado con el indicador descolocado, a un
 * `ResizeObserver` para el redimensionado y a un caso especial para las
 * fuentes que cargan tarde. Nada de eso aparece si la geometría es aritmética.
 *
 * El precio es que la etiqueta más larga fija el ancho de todas. Con dos o
 * tres opciones cortas —que es para lo que existe un control segmentado— eso
 * no se nota; con etiquetas dispares se notaría, y sería la señal de que ese
 * conjunto pedía otro control.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';

export interface SegmentItem {
  key: string;
  label: ReactNode;
  /** Si viene, el segmento es un enlace de navegación en vez de un botón. */
  href?: string;
  /** Texto accesible cuando `label` es un icono o una abreviatura. */
  title?: string;
}

interface SegmentedControlProps {
  items: readonly SegmentItem[];
  activeKey: string;
  /** Solo para el modo botón. En modo enlace navega Next. */
  onChange?: (key: string) => void;
  /** Etiqueta del grupo para lectores de pantalla. */
  ariaLabel: string;
  className?: string;
  /** Compacto: para dentro de una tarjeta, donde compite con el contenido. */
  dense?: boolean;
}

export function SegmentedControl({
  items,
  activeKey,
  onChange,
  ariaLabel,
  className = '',
  dense = false,
}: SegmentedControlProps) {
  const n = items.length;
  const activeIndex = Math.max(
    0,
    items.findIndex((i) => i.key === activeKey),
  );

  return (
    <div
      className={`seg ${className}`}
      role="group"
      aria-label={ariaLabel}
      style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
    >
      {/* La pastilla es `aria-hidden`: no aporta nada a un lector de pantalla,
          que ya conoce el estado por `aria-current` / `aria-pressed`. */}
      <div
        aria-hidden
        className="seg-indicator"
        style={{
          width: `calc((100% - 6px) / ${n})`,
          transform: `translateX(calc(${activeIndex} * 100%))`,
        }}
      />

      {items.map((item) => {
        const on = item.key === activeKey;
        const content = (
          <span className="truncate" style={dense ? { fontSize: 12 } : undefined}>
            {item.label}
          </span>
        );

        if (item.href) {
          return (
            <Link
              key={item.key}
              href={item.href}
              title={item.title}
              data-on={on}
              aria-current={on ? 'page' : undefined}
              className="seg-item"
              style={dense ? { padding: '5px 10px' } : undefined}
            >
              {content}
            </Link>
          );
        }

        return (
          <button
            key={item.key}
            type="button"
            title={item.title}
            data-on={on}
            aria-pressed={on}
            onClick={() => onChange?.(item.key)}
            className="seg-item"
            style={dense ? { padding: '5px 10px' } : undefined}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
