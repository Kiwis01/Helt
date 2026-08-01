import { useId } from 'react';

/**
 * El icono de HELT, en SVG inline.
 *
 * Es una transcripción literal de `HELT-logo-kit/helt-icon.svg` (lienzo 512,
 * esquina r=118, degradado aqua → teal → deep teal, dos barras de voz y el
 * trazo del pulso). Inline y no `<img src="/icon.svg">` a propósito: el brief
 * prohíbe depender de la red, y un logo servido como recurso es exactamente el
 * elemento que se cae con un 404 y deja un hueco en la cabecera durante la
 * demo. Inline, la marca es parte del bundle: o está toda la página, o no está
 * ninguna.
 *
 * Los degradados llevan `useId()` en el identificador. Dos instancias del
 * componente en la misma página con el mismo `id="tile"` hacen que la segunda
 * pise a la primera en el documento — el bug clásico de los SVG copiados a
 * mano, y se manifiesta como "el logo del sidebar perdió el color".
 *
 * `mono` sirve para cuando la marca va SOBRE color (una cápsula de acento, el
 * badge de escalación): allí el cuadrado degradado compite con el fondo, así
 * que se dibuja solo el glifo —barras + pulso— en `currentColor`, y hereda el
 * color del texto que lo rodea.
 */
export default function HeltMark({
  size = 28,
  mono = false,
  title = 'HELT',
  className,
}: {
  /** Lado del cuadrado en px. El icono es cuadrado; no hay variante ancha. */
  size?: number;
  /** Solo el glifo, en `currentColor`. Para uso sobre superficies de color. */
  mono?: boolean;
  /** Nombre accesible. `title=""` lo vuelve decorativo (`aria-hidden`). */
  title?: string;
  className?: string;
}) {
  // Un id por instancia: los degradados son globales al documento.
  const uid = useId().replace(/:/g, '');
  const tile = `helt-tile-${uid}`;
  const sheen = `helt-sheen-${uid}`;

  // El glifo es idéntico en las dos variantes; lo único que cambia es si lleva
  // baldosa debajo y de dónde saca el color.
  const glyph = (
    <>
      <g fill={mono ? 'currentColor' : '#ffffff'}>
        <rect x="150" y="188" width="34" height="136" rx="17" />
        <rect x="328" y="188" width="34" height="136" rx="17" />
      </g>
      <path
        d="M150 256 H206 L232 256 L256 150 L280 356 L306 256 H362"
        fill="none"
        stroke={mono ? 'currentColor' : '#ffffff'}
        strokeWidth="32"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {!mono && (
        <>
          <defs>
            {/* El degradado diagonal de la hoja de marca: aqua a teal a deep
                teal en la diagonal del lienzo, no en horizontal. */}
            <linearGradient id={tile} x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#2DE2E6" />
              <stop offset="0.55" stopColor="#12B5C9" />
              <stop offset="1" stopColor="#0A8FA6" />
            </linearGradient>
            {/* Brillo superior: lo que hace que la baldosa se lea como un icono
                de iOS y no como un cuadrado plano de color. */}
            <linearGradient id={sheen} x1="0" y1="0" x2="0" y2="512" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.16" />
              <stop offset="0.5" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <rect width="512" height="512" rx="118" fill={`url(#${tile})`} />
          <rect width="512" height="512" rx="118" fill={`url(#${sheen})`} />
        </>
      )}
      {glyph}
    </svg>
  );
}
