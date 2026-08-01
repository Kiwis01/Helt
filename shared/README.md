# `shared/` — fuente unica de verdad

Tipos, constantes y fixtures que comparten los tres servicios de Loop.

> **ESTADO: PROVISIONAL.**
> Segun el reparto, `contracts.ts` y `constants.ts` los publica **Kiwis** en T0.
> A la hora de arrancar `loop-voice` todavia no existian, asi que los escribio
> **Lewis** transcribiendo la seccion 4 de `plandevs/02-LEWIS-voice-safety.md`
> (identica en los tres briefs).
>
> **Cuando Kiwis publique los suyos: `git diff`, gana el de Kiwis, y se avisa
> en el grupo.** Los tres hacen pull.

## Reglas

- `shared/` es **solo lectura** para todos menos el agente de Fundacion.
  Cualquier cambio va por PR + aviso a los tres.
- Aqui **nunca** hay secretos. Los secretos viven en el `.env` de la raiz
  (que no se commitea) y su plantilla vacia esta en `ops/.env.example`.
- Todas las marcas de tiempo son ISO-8601 en UTC.

## Contenido

| Archivo | Que es |
|---|---|
| `contracts.ts` | Tipos TypeScript de los 6 contratos + esquemas zod de los payloads que loop-voice produce o consume. |
| `constants.ts` | Puertos, IDs fijos del demo, codigos LOINC/SNOMED/CPT, rutas de API. |
| `fixtures/*.json` | Payloads de ejemplo. Con `USE_MOCKS=true` los servicios leen de aqui en vez de hacer HTTP. |

## Esquemas zod exportados

Solo se validan los payloads que cruzan un limite de servicio:

- `patientContextSchema` — lo que loop-voice **consume** de loop-core.
- `episodeWritebackSchema` — lo que loop-voice **produce** hacia loop-core.
- `coverageCheckResponseSchema` — lo que loop-voice **consume** de loop-coverage.

Ademas hay esquemas de apoyo (`coverageCheckRequestSchema`, `outcomesSummarySchema`,
`observationSeriesSchema`, `demoSpikeRequestSchema`, ...).

**Los esquemas son deliberadamente permisivos** en los campos que son uniones de
strings abiertas (`current.*.trend`, `carePlan.activities[].type`,
`conditions[].clinicalStatus`, `escalation.action`). Motivo: la regla numero uno
de loop-voice es que **la llamada nunca se cae**. Un valor inesperado de otro
servicio no debe reventar un `parse()` en mitad de un episodio.
Los clientes deben usar `safeParse` y degradar, no `parse` a secas.

## Fixtures

| Fixture | Para que |
|---|---|
| `context.happy.json` | Contrato 1 literal. Paciente en panico pero **dentro** del safetyEnvelope: HR 118, RR 24. Es el camino feliz del demo. |
| `context.redflag.json` | Igual, pero **fuera** del envelope: HR 163 (max 171), RR 34 (max 36). Dispara `RF-08-BIOMETRIC-ENVELOPE`. |
| `coverage.covered.json` | Contrato 3 literal, `status: "covered"`, copago 2500 centavos. |
| `coverage.unknown.json` | Mismo shape con `status: "unknown"` y todo lo monetario en `null`. Es el fallback honesto cuando Stedi no responde. **Nunca se inventa un numero.** |
| `episode.sample.json` | Contrato 2 literal, con transcript ya redactado. |
| `outcomes.sample.json` | Contrato 4 (`/outcomes`) literal. El grafico estrella del pitch. |

### Convencion de `voiceScript`

El campo `voiceScript` de una actividad del care plan usa **`\n` como separador
de fases locutables**. El orquestador de voz habla una linea, respeta el timing
de la fase (p.ej. 4 segundos por conteo en la respiracion de caja) y pasa a la
siguiente. Un `voiceScript` de una sola linea se locuta de corrido.

Esta convencion la fijo loop-voice; si a Kiwis no le sirve, se cambia por PR.

### Desviaciones conscientes respecto del texto del brief

El brief dejo varios `"..."` como marcador. Se rellenaron con contenido real y
locutable, porque un fixture con `"..."` no sirve para probar nada:

- `carePlan.activities[].voiceScript` de `cp-act-1`, `cp-act-2` y `cp-act-3`
  (el brief no traia `voiceScript` para `cp-act-3`; se anadio).
- `transcript.turns[].text` en `episode.sample.json`.
- `raw271Id` en `coverage.covered.json` (el brief traia `"stedi-271-..."`).

Todo lo demas es literal.
