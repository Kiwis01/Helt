import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'Loop — Vista clínica',
  description:
    'Dashboard clínico de Loop: baseline de 30 días, episodios, outcomes por intervención y llamada en vivo.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#090d12',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      {/* `overflow-x-hidden` en el body es la última red contra el scroll
          horizontal: aunque un panel se pase de ancho, la página no se
          desplaza y el proyector nunca recorta por el lado. */}
      <body className="h-full overflow-x-hidden bg-bg font-sans text-ink">{children}</body>
    </html>
  );
}
