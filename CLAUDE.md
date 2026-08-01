# Loop — reglas del repo

Compañero de voz de circuito cerrado para ansiedad crónica. Hackathon Y Combinator × Medplum.
Tres personas construyen tres plataformas en paralelo, cada una con su propia sesión de Claude Code.

Los planes por persona están en [`plandevs/`](plandevs/). Léelos antes de tocar nada.

## Aislamiento por carpeta — la regla que hace que esto funcione

| Carpeta | Dueño | Servicio | Puerto |
|---|---|---|---|
| `core/` | Kiwis | `loop-core` — gateway sobre Medplum, FHIR | 3001 |
| `voice/` | Lewis | `loop-voice` — Deepgram + motor de red-flags | 3002 |
| `dashboard/` | Carlos | `loop-dashboard` — vista clínica | 3000 |
| `coverage/` | Carlos | `loop-coverage` — elegibilidad Stedi | 3003 |

**Cada sesión de Claude Code edita únicamente la carpeta de su dueño.** Nunca las de los demás.
Hay tres agentes trabajando en paralelo sobre el mismo repo; esta regla es lo único que evita que se pisen.

## `shared/` es de solo lectura

`shared/contracts.ts` es la fuente única de verdad de los 6 contratos de integración.
Se congeló en T0. Cambiarlo rompe a dos personas a la vez.

**Protocolo de cambio:** mensaje al grupo → PR a `shared/` → los tres hacen pull → confirmación de los tres.

Después de cualquier cambio en `shared/`:

```bash
npm run fixtures:validate
```

Eso no solo valida esquemas: comprueba las invariantes que cruzan archivos (que el gráfico de outcomes
cuadre con la lista de episodios, que el fixture de red-flag de verdad viole el envelope de seguridad,
que los picos declarados existan en las series). Si falla, no construyas encima.

## `USE_MOCKS` — la palanca de integración

Todo servicio que llama a otro respeta `USE_MOCKS`. En `true` lee de `shared/fixtures/`; en `false`
hace HTTP real. Nadie se bloquea esperando a que otro termine, y la integración final es cambiar
una variable de entorno.

Cada servicio debe **degradar, nunca caerse**: si un upstream no responde, se usa el fixture y se
marca visiblemente que el dato es de respaldo.

## Convenciones

- Comentarios y texto de UI en **español**. Identificadores, endpoints y campos JSON en **inglés**,
  exactamente como están en `shared/contracts.ts`.
- Comentar el *porqué*, no el *qué*.
- TypeScript estricto. `any` solo con un comentario que lo justifique.
- Sin assets ni fuentes externas en el dashboard: el wifi del hackathon puede morir.

## Seguridad — aplica a todo el repo

- El motor de red-flags de `voice/` es **determinista y corre antes del LLM**. No es una instrucción
  de prompt, es código. Nunca se mueve a un prompt.
- El agente **contextualiza, nunca diagnostica**.
- Biometría normal es motivo para tranquilizar; **nunca** para descartar una emergencia.
- `coverage/` nunca inventa un monto. Si no conoce el dato, la frase lo dice.
- Cero PHI real. Todo el dataset es sintético y generado por `shared/fixtures/generate.mjs`.

## Comandos

```bash
npm install                  # una vez, en la raíz (workspaces)
npm run fixtures:generate    # regenera las series y agregados sintéticos
npm run fixtures:validate    # esquemas + invariantes cruzadas
npm run dev                  # dashboard + coverage a la vez
npm run typecheck            # todos los workspaces
npm test                     # todos los workspaces
```

`core/` y `voice/` se añaden a `workspaces` en el `package.json` raíz cuando existan.
