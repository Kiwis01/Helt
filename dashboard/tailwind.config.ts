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
 * (`bg-surface/60`) NO funcionan sobre estos colores. Para transparencias hay
 * utilidades explícitas en globals.css.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        line: 'var(--line)',
        'line-strong': 'var(--line-strong)',
        ink: 'var(--ink)',
        'ink-2': 'var(--ink-2)',
        'ink-3': 'var(--ink-3)',
        accent: 'var(--accent)',
        'accent-dim': 'var(--accent-dim)',
        danger: 'var(--danger)',
        warn: 'var(--warn)',
        ok: 'var(--ok)',
        'chart-hr': 'var(--chart-hr)',
        'chart-hrv': 'var(--chart-hrv)',
        'chart-rr': 'var(--chart-rr)',
        'chart-episode': 'var(--chart-episode)',
      },
      fontFamily: {
        // Tipografía del sistema a propósito: el wifi del hackathon puede
        // morir y una fuente que no carga arruina el primer plano del demo.
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'SF Mono',
          'Menlo',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
      },
      fontSize: {
        // Escala pensada para leerse proyectada: no hay nada por debajo de 11px.
        '2xs': ['0.6875rem', { lineHeight: '0.875rem', letterSpacing: '0.04em' }],
      },
      borderRadius: {
        card: '10px',
      },
    },
  },
  plugins: [],
};

export default config;
