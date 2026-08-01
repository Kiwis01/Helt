'use client';

/**
 * Barra de navegación persistente. Es la misma en todas las vistas.
 *
 * ## El problema que resuelve
 *
 * Antes cada ruta traía su propia cabecera: la agenda tenía un enlace a
 * `/loop`, el expediente tenía uno a `/loop` y otro de vuelta a la agenda, y
 * `/loop` no tenía NINGUNO —era un callejón sin salida del que solo se salía
 * con el botón atrás del navegador—. Tres cabeceras distintas para tres
 * vistas del mismo producto también significa que el usuario no puede
 * construirse un modelo de dónde está.
 *
 * ## Por qué ya no hay control segmentado
 *
 * Llevaba dos "mundos", Chart y Loop, porque el compañero de voz era una ruta
 * hermana con su propio paciente. Ya no lo es: Loop es una sección del
 * expediente del paciente enrolado. Un control segmentado de un solo elemento
 * no es navegación, es un adorno que ocupa el sitio donde antes había una
 * decisión — así que se fue, y con él el atajo `2`.
 *
 * ## Atajos de teclado
 *
 * `1` vuelve a la agenda y `Esc` sube un nivel. Existen porque esto se conduce
 * desde un portátil delante de un público: en el escenario no quieres buscar un
 * objetivo de 90 px con el trackpad mientras hablas. Se ignoran mientras se
 * escribe en un campo, para no secuestrar la escritura.
 */

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import HeltMark from '@/components/brand/HeltMark';

/** ¿Se está escribiendo? Entonces las teclas sueltas no son atajos. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
  );
}

interface AppNavProps {
  /** Acciones contextuales de la vista: badge de origen, controles de demo. */
  actions?: ReactNode;
}

export function AppNav({ actions }: AppNavProps) {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // Con modificador no es un atajo nuestro: puede ser del sistema o del
      // navegador, y pisarlo sería peor que no tener atajo.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;

      if (event.key === '1') {
        event.preventDefault();
        router.push('/');
      } else if (event.key === 'Escape') {
        // Sube un nivel en vez de `router.back()`: el historial puede venir de
        // cualquier sitio y "atrás" desde el expediente podría sacarte de la
        // aplicación en mitad del demo. Subir es predecible siempre.
        if (pathname.startsWith('/paciente/')) {
          event.preventDefault();
          router.push('/');
        }
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router, pathname]);

  return (
    <header
      className="sticky top-0 z-30 flex shrink-0 items-center gap-4 border-b border-hair px-5"
      style={{
        height: 'var(--nav-h)',
        /* Vidrio de barra, no una quinta tarjeta: sin borde propio ni sombra,
           solo el desenfoque y el filo inferior. Así la barra pertenece a la
           ventana y no compite con los paneles que hay debajo. */
        background: 'rgba(7, 12, 17, 0.6)',
        backdropFilter: 'var(--blur-strong)',
        WebkitBackdropFilter: 'var(--blur-strong)',
      }}
    >
      {/* El wordmark también es el camino a casa. Es la convención de toda
          aplicación web desde hace veinte años y no hace falta enseñarla. */}
      <Link
        href="/"
        title="Home"
        className="flex shrink-0 items-center gap-2.5 transition-opacity hover:opacity-70"
      >
        <HeltMark size={24} />
        <span className="text-[15px] font-semibold tracking-[0.18em] text-ink">HELT</span>
      </Link>

      {actions ? <div className="ml-auto flex shrink-0 items-center gap-3">{actions}</div> : null}
    </header>
  );
}
