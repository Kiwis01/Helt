# loop-dashboard

Vista clínica de Loop (hackathon YC × Medplum). Next.js. Puerto 3000.

## Reglas
- SOLO edito archivos dentro de `dashboard/`. Nunca toco `core/`, `voice/` ni `coverage/`.
- `../shared/contracts.ts` es de solo lectura.
- NUNCA hablo FHIR ni Medplum directo. Consumo loop-core (:3001).
- NUNCA implemento lógica de red-flags. Solo pinto el evento safety.escalation.

## Stack
- Next.js App Router + TypeScript + Tailwind
- @medplum/react donde aporte (es sponsor, se nota)
- Recharts para series de tiempo
- EventSource nativo para el SSE de :3002

## Esto se proyecta en una pantalla grande frente a jueces
- Diseñar para 1280x720. Sin scroll horizontal. Texto legible desde lejos.
- Todo estado (vacío, cargando, error) debe verse intencional, no roto.
- Si un endpoint falla, degrado con elegancia. Nunca una pantalla en blanco.

## Prioridad de las 3 vistas
1. Gráfico de outcomes por intervención — es la frase de cierre del pitch.
2. Panel de llamada en vivo con transcript + badge de escalación.
3. Baseline de 30 días con episodios marcados.

---

## Estado del scaffold (léelo antes de tocar nada)

La base ya está construida: configuración, capa de datos, layout y placeholders.
Faltan los gráficos y el panel en vivo, marcados en `src/app/page.tsx` con
bloques `PLACEHOLDER —` que dicen exactamente qué datos hay y qué requisitos
hereda cada hueco.

### Capa de datos — `src/lib/core-client.ts`

Es la única puerta a loop-core. Envuelve los Contratos 4 y 6:

```ts
fetchSummary()                          -> DataResult<PatientSummary>
fetchObservations({ metric, from?, to?, bucket? }) -> DataResult<ObservationSeries>
fetchEpisodes()                         -> DataResult<EpisodeList>
fetchOutcomes()                         -> DataResult<OutcomesSummary>
triggerDemoSpike(profile)               -> DataResult<DemoSpikeResponse>
resetDemo()                             -> DataResult<DemoResetResponse>
```

Invariantes que NO se rompen:

- **Nunca lanzan.** Timeout de `TIMEOUTS_MS.contextFetch` (2000 ms), validación
  zod de la respuesta y, ante cualquier fallo, el fixture equivalente. Quien
  las consume no necesita try/catch ni error boundary.
- **Siempre dicen de dónde vienen los datos.** `DataResult.source` es `'live'`
  o `'fixture'`, con `reason` y `detail`. Ese valor sube hasta el badge de la
  barra superior. No lo escondas: es lo que evita que alguien enseñe datos
  falsos creyendo que son reales.
- `NEXT_PUBLIC_USE_FIXTURES=true` corta la red por completo (modo respaldo).

Si añades una lectura nueva, pásala también por `aggregateSource()` en
`page.tsx` para que el badge la tenga en cuenta.

### Diseño

- Tema oscuro único, sin modo claro. Colores en `src/app/globals.css` como
  custom properties y expuestos en `tailwind.config.ts`.
- Series de gráficos: `var(--chart-hr)`, `var(--chart-hrv)`, `var(--chart-rr)`,
  `var(--chart-episode)`, banda de baseline `var(--chart-band)`. Funcionan
  directas en atributos SVG de Recharts.
- Los colores del tema son `var()`, así que los modificadores de opacidad de
  Tailwind (`bg-danger/10`) NO aplican. Usa `.tint-danger`, `.tint-warn`,
  `.tint-ok`, `.tint-accent` de `globals.css`.
- Manrope, versionada en `src/fonts/` y servida con `next/font/local`. Cero
  assets externos **ni en runtime ni en build**: el wifi puede morir y un
  `next build` con la caché limpia tiene que seguir saliendo. Nada de
  `next/font/google`, que descarga en cada build.
- El layout es una rejilla de altura fija. Cada nivel lleva `min-h-0` /
  `min-w-0`: si un panel crece, hace scroll dentro de sí mismo. Nunca añadas
  altura fija a un `ResponsiveContainer` de Recharts.

### Formateo

Todo pasa por `src/lib/format.ts`. Fija locale y `timeZone: 'UTC'` a propósito:
los datos se pintan en el servidor y algunos paneles se rehidratan en el
cliente, y sin zona fija el mismo episodio saldría con dos horas distintas.
Nada lanza; un valor inválido devuelve `—`.
