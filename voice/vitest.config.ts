import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Los tests viven junto al codigo que prueban (src/**/*.test.ts).
    // El suite critico es el del motor de red-flags: src/safety/*.test.ts.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    globals: false,
    testTimeout: 10_000,
    reporters: ['default'],
    // El andamio ya no aplica: los 9 suites existen (331 casos, 90 de ellos del
    // motor de red-flags). Dejarlo en `true` convertiria un glob roto o un
    // renombrado de carpeta en un `npm test` verde con CERO tests ejecutados,
    // justo en la pieza que los jueces van a interrogar. Que falle ruidoso.
    passWithNoTests: false,
  },
});
