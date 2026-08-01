import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import localFont from 'next/font/local';

import './globals.css';

/**
 * Manrope vive EN EL REPO (`src/fonts/`), no en next/font/google.
 *
 * Con el loader de Google el runtime ya era local, pero el BUILD no: cada
 * `next build` con la caché limpia iba a fonts.googleapis.com a bajar los
 * .woff2. En el hackathon eso significa que reconstruir sin wifi te deja sin
 * tipografía, y el brief pide que nada dependa de la red (§11 y CLAUDE.md).
 * Con el archivo versionado, el único requisito para construir es el repo.
 *
 * Es el subconjunto `latin` de la fuente VARIABLE (200–800 en un solo archivo,
 * 24 KB): un peso por eje en vez de cuatro archivos estáticos. Los glifos fuera
 * de latin-1 —flechas, ▲▼— caen a la fuente del sistema carácter a carácter,
 * exactamente igual que antes: ese subconjunto tampoco los traía.
 */
const manrope = localFont({
  src: '../fonts/manrope-latin-variable.woff2',
  weight: '200 800',
  style: 'normal',
  variable: '--font-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Loop — Vista clínica',
  description:
    'Dashboard clínico de Loop: baseline de 30 días, episodios, outcomes por intervención y llamada en vivo.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#070c11',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" className={manrope.variable}>
      {/* `overflow-x-hidden` en el body es la última red contra el scroll
          horizontal: aunque un panel se pase de ancho, la página no se
          desplaza y el proyector nunca recorta por el lado. */}
      <body className="h-full overflow-x-hidden bg-bg font-sans text-ink">
        {/* Aurora fija detrás de todo: da al vidrio algo sobre lo que posarse.
            Sin ella los paneles se leen como rectángulos grises. */}
        <div className="aurora" aria-hidden />
        <div className="relative z-10 h-full">{children}</div>
      </body>
    </html>
  );
}
