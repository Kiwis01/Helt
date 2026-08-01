import type { Config } from 'tailwindcss';

/**
 * Paleta única, oscura, sin modo claro.
 *
 * Los valores viven como custom properties en globals.css y aquí solo se
 * referencian: los gráficos de Recharts necesitan los mismos colores como
 * strings CSS (`stroke="var(--chart-hr)"`), y duplicar hex en dos sitios es
 * cómo se termina con un gráfico que no combina con su tarjeta.
 *
 * Consecuencia a tener en cuenta: los modificadores de opacidad de Tailwind
 * (`bg-glass/60`) NO funcionan sobre estos colores. Para transparencias hay
 * utilidades explícitas en globals.css (.pill-*, .tile, .glass).
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        glass: 'var(--glass)',
        'glass-2': 'var(--glass-2)',
        hair: 'var(--hair)',
        line: 'var(--line)',
        ink: 'var(--ink)',
        'ink-2': 'var(--ink-2)',
        'ink-3': 'var(--ink-3)',
        accent: 'var(--accent)',
        danger: 'var(--danger)',
        warn: 'var(--warn)',
        ok: 'var(--ok)',
        'chart-hr': 'var(--chart-hr)',
        'chart-hrv': 'var(--chart-hrv)',
        'chart-rr': 'var(--chart-rr)',
        'chart-episode': 'var(--chart-episode)',
      },
      fontFamily: {
        // Manrope va versionada en `src/fonts/` y se sirve con next/font/local
        // (ver `src/app/layout.tsx`). Cero red: ni en runtime ni al construir.
        // El wifi del hackathon puede morir y la tipografía sigue ahí.
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        // Escala pensada para leerse proyectada: nada por debajo de 11px.
        '2xs': ['0.6875rem', { lineHeight: '0.875rem', letterSpacing: '0.02em' }],
      },
      borderRadius: {
        card: 'var(--radius)',
        tile: 'var(--radius-sm)',
      },
      backdropBlur: {
        glass: '30px',
      },
      transitionTimingFunction: {
        ease: 'var(--ease)',
      },
    },
  },
  plugins: [],
};

export default config;
