# loop-voice (`:3002`)

Agente de voz + **motor de red-flags determinista** para Loop (hackathon YC × Medplum).
Es la plataforma de Lewis. Consume el contexto clínico de loop-core (`:3001`, Kiwis),
llama a loop-coverage (`:3003`, Carlos) y emite un stream SSE que pinta el dashboard (`:3000`, Carlos).

> **La pieza que importa está en `src/safety/`.** Es determinista, pura, sin I/O y corre
> **antes** de cualquier llamada al LLM, en cada turno del paciente. No es una instrucción de
> prompt: es un `if`. Se puede interrogar desde la terminal, sin credenciales y sin red.

---

## Arrancar

```bash
npm install                 # desde la RAÍZ del repo (es un workspace)
npm -w voice start          # levanta :3002
# abrir http://localhost:3002
```

Por defecto arranca con `USE_MOCKS=true`: lee `shared/fixtures/` en vez de llamar a `:3001` y
`:3003`. **No necesitas que Kiwis ni Carlos hayan terminado nada para que esto funcione.**

Otros comandos:

```bash
npm -w voice test                                  # suite completa (vitest)
npm -w voice run smoke                             # smoke de punta a punta, 9 comprobaciones
npm -w voice run redflag "me duele el pecho y se me va al brazo"
npm -w voice run build                             # tsc --noEmit
INTERVENTION_SPEED=10 npm -w voice start           # ensayos: acorta las pausas de la respiración
```

### Qué levanta

| Ruta | Qué es |
|---|---|
| `GET /` | cliente push-to-talk del navegador |
| `GET /healthz` · `GET /api/v1/status` | salud y estado (fuente del contexto, proveedor LLM, TTS…) |
| `GET /api/v1/live/stream` | **SSE — la dependencia de Carlos** |
| `GET /api/v1/live/events?limit=50` | los mismos eventos en JSON (plan B si el `EventSource` falla) |
| `POST /api/v1/live/test-event` | inyecta un evento falso al stream |
| `WS /api/v1/call/stream` (alias `/api/v1/call/socket`) | la llamada: PCM crudo entra, audio y transcript salen |
| `POST /api/v1/call/simulate` | mete un turno de paciente **sin micrófono** |
| `POST /api/v1/debug/redflag` | una frase → el veredicto crudo del motor |
| `POST /api/v1/debug/tts` | un texto → el audio, para probar la voz |
| `GET /api/v1/calls` | llamadas vivas |

---

## Variables de entorno

Se leen del `.env` de la **raíz** del repo (compartido por los tres servicios).
`assertConfig()` avisa al arrancar de cada credencial que falta y de qué se degrada.
**El servidor nunca se niega a arrancar por una credencial ausente**, porque el motor de
red-flags no necesita ninguna y ese es el entregable irrenunciable.

| Variable | Default | Si falta / qué se degrada |
|---|---|---|
| `VOICE_PORT` | `3002` | arranca en 3002. **Nunca se lee `PORT`** — ver divergencias. |
| `VOICE_HOST` | `0.0.0.0` | bind a todas las interfaces |
| `USE_MOCKS` | `true` | con `true` lee `shared/fixtures/`. Solo se apaga con literal `USE_MOCKS=false`. |
| `LOOP_CORE_URL` | `http://localhost:3001` | si `:3001` no responde: último contexto conocido → fixture → contexto embebido. **La llamada nunca se cae.** El episodio se guarda en `voice/.episodes-pending/`. |
| `LOOP_COVERAGE_URL` | `http://localhost:3003` | si `:3003` falla: `status: unknown` y un `voiceSummary` honesto. **Nunca se inventa un copago.** |
| `LOOP_PATIENT_ID` | `loop-demo-patient-001` | paciente fijo del demo |
| `DEEPGRAM_API_KEY` | — | **sin ella no hay STT**: el micrófono no transcribe y hay que usar el modo texto del cliente. El TTS cae a Polly. |
| `DG_STT_MODEL` | `nova-3` | modelo de Deepgram Listen |
| `DG_STT_LANGUAGE` | `multi` | detecta ES/EN en la misma sesión |
| `DG_TTS_VOICE` | `aura-2-selena-es` | voz de Aura-2 |
| `AGENT_MODEL_ID` | — | **sin él no hay LLM**: el agente cae al proveedor `scripted`, que solo lee guiones fijos y cita los números del baseline. La conversación libre se pierde; el red-flag, el care plan y el coverage siguen funcionando. |
| `AWS_REGION` | `us-east-1` | región de Bedrock y Polly |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | sin ellas no hay Bedrock (LLM) **ni** Polly (TTS de respaldo) |
| `POLLY_VOICE` / `POLLY_ENGINE` | `Lupe` / `generative` | voz del respaldo de TTS |
| `TIMEOUT_CONTEXT_MS` | `2000` | vencido, se usa el último contexto conocido |
| `TIMEOUT_COVERAGE_MS` | `3000` | vencido, `unknown` honesto |
| `TIMEOUT_EPISODE_MS` | `5000` | vencido, el episodio se guarda en disco |
| `TIMEOUT_TTS_MS` | `4000` | vencido, Deepgram cede el turno a Polly |
| `INTERVENTION_SPEED` | `1` | divisor de las pausas de la respiración. `1` = tiempo real (escenario) |
| `LOG_LEVEL` | `info` | `debug` para ver cada turno |

**Sin ninguna credencial** loop-voice sigue arrancando y sigue siendo demostrable: el motor de
red-flags, el SSE, el episodio y el care plan funcionan. Lo único que se pierde es la voz y la
conversación libre.

---

## Divergencias frente al brief (y por qué)

El brief `plandevs/02-LEWIS-voice-safety.md` describe cuatro cosas que aquí se hicieron
distinto. Ninguna es un atajo: las cuatro se decidieron contra el `.env` real del equipo.

### (a) AWS Bedrock Converse en vez de `ANTHROPIC_API_KEY`

El brief lista `ANTHROPIC_API_KEY` entre las variables compartidas. **Esa variable no tiene
valor en el `.env` real.** Lo que sí tiene son credenciales de AWS y un
`AGENT_MODEL_ID=us.anthropic.claude-sonnet-4-5-...` (un inference-profile de Bedrock ya
verificado en esa cuenta). Así que el camino primario es
`@aws-sdk/client-bedrock-runtime` con `ConverseStreamCommand`.

El model id **se lee siempre de `process.env.AGENT_MODEL_ID`**, nunca hardcodeado.
La capa vive detrás de la interfaz `LlmProvider` (`src/agent/llm.ts`), así que cambiar de
proveedor es escribir una clase nueva y no tocar el orquestador. Si Bedrock falla o no hay
credenciales, entra el proveedor `scripted` (sin red) y la llamada sigue.

### (b) Camino manual de STT/TTS en vez de Voice Agent API

El brief propone Deepgram **Voice Agent API** (STT + LLM + TTS en un websocket) como ruta
rápida. Aquí se usa el camino manual: **Deepgram Listen (WS, `nova-3`, `language=multi`) para
STT + Bedrock para el LLM + Aura-2 para TTS**, con caída automática a AWS Polly.

Dos razones, las dos de seguridad, y por eso no es negociable:

1. **El motor de red-flags DEBE ver el transcript en el servidor.** Con Voice Agent API el
   modelo decide la respuesta dentro del websocket de Deepgram; no hay un punto donde
   interponer un `evaluate()` determinista antes del LLM. Ese `evaluate()` es el entregable
   central del brief (sección 5), así que la arquitectura se dobla a él y no al revés.
2. **La API key nunca sale al navegador.** El browser manda PCM crudo por WS a `:3002` y este
   proceso lo reenvía a Deepgram. Si el STT corriera en el cliente, un navegador roto (o
   manipulado) podría mandar el texto que quisiera, y el motor de seguridad pasaría de ser una
   garantía a ser una sugerencia.

Efecto secundario bueno: el TTS se trocea por frases (`src/audio/sentenceSplitter.ts`), que es
la palanca principal para el objetivo de <800 ms del brief.

### (c) `VOICE_PORT` en vez de `PORT`

El `.env` compartido define `PORT=8787` para otro proceso del equipo. Si loop-voice leyera
`PORT` se levantaría en 8787, el dashboard de Carlos no encontraría el SSE en `:3002` y
romperíamos su servicio sin que nadie entendiera por qué. `config.ts` lee **solo `VOICE_PORT`**
(default 3002) e ignora `PORT` a propósito.

Además, al arrancar se hace un `GET /healthz` contra `localhost:<puerto>` para confirmar que
quien responde ahí somos nosotros: en Windows dos procesos pueden escuchar en el mismo puerto
con bindings distintos, y el banner sale igual de verde mientras el tráfico se lo lleva un
servidor fantasma de otra sesión.

### (d) `shared/contracts.ts` lo escribió Lewis, provisionalmente

Según el reparto, `shared/contracts.ts` lo publica **Kiwis en T0**. A la hora de arrancar
loop-voice ese archivo no existía y sin él no se compila nada. El que hay ahora es una
**transcripción literal de la sección 4 del brief** (idéntica en los tres), con dos matices
documentados en su cabecera:

- los **tipos** son la referencia exacta del brief;
- los **esquemas zod** son deliberadamente permisivos en las uniones de string abiertas
  (`trend`, `activity.type`, `clinicalStatus`) para que un valor inesperado de otro servicio no
  tire la llamada.

**Cuando Kiwis publique el suyo: gana el de Kiwis.** El protocolo está escrito en la cabecera
del archivo y repetido en `ops/INTEGRACION-LEWIS.md`. `voice/src/types.ts` re-exporta todo, así
que la reconciliación se ve como errores de compilación en un solo sitio.

> Nota relacionada: `patientContextSchema` exige todos los campos del ejemplo del brief.
> Como eso convertiría cualquier omisión inocua de Kiwis en "descarto el payload live y uso el
> fixture" (y el agente citaría números falsos con total aplomo), `src/clients/contextCoercion.ts`
> normaliza el contexto antes de validarlo: rellena lo ausente, **deriva** los `deltas` de
> `current` y `baseline` cuando faltan, y marca lo que no llegó con centinelas que el prompt
> sabe callar. Lo que **no** rellena es la frecuencia cardiaca: sin ella el contexto es
> inservible y se degrada de verdad.

---

## Probar el camino de red-flag sin micrófono

Tres formas, de menos a más completa. **Ninguna necesita credenciales ni red.**

### 1. Desde la terminal (el motor solo)

```bash
npm -w voice run redflag "me duele el pecho y se me corre al brazo izquierdo"
# → RF-01-CHEST-PAIN-RADIATING → advise-911

npm -w voice run redflag "estoy un poco nervioso por el trabajo"
# → sin escalación (que es el producto: no todo dispara)
```

### 2. Por HTTP (el mismo `evaluate()` que usa la llamada en vivo)

```bash
curl -s http://localhost:3002/api/v1/debug/redflag \
     -H 'content-type: application/json' \
     -d '{"text":"me duele el pecho y se me va al brazo"}' | jq .result
```

Devuelve `ruleId`, `action`, `script`, `matchedEvidence` y `severity`, más un bloque `engine`
con el orden de evaluación de las 9 reglas y `llmInvolved: false`. Se puede forzar la biometría
para probar RF-08 sin tocar el fixture:

```bash
# HR 163 con el envelope en 150
curl -s http://localhost:3002/api/v1/debug/redflag \
     -H 'content-type: application/json' -d '{"text":"estoy nervioso","hr":163}'
```

### 3. Un turno real en el pipeline completo (sin micrófono)

```bash
curl -s http://localhost:3002/api/v1/call/simulate \
     -H 'content-type: application/json' \
     -d '{"text":"me duele mucho el pecho y se me va al brazo izquierdo"}' | jq .result
```

Corre **exactamente** el mismo `runPatientTurn` que la voz. Si esto escala, la llamada real
escala. La respuesta trae `llmInvoked: false`, la regla que disparó y el snapshot de la sesión;
por el SSE sale `safety.escalation` y después `call.ended` + `episode.written`.

### 4. La prueba que no admite interpretación

```bash
npm -w voice run smoke
```

La comprobación 6 inyecta un `LlmProvider` espía con un contador, manda una frase de red-flag
por `/simulate` y afirma que el contador vale **cero** al terminar. No es una promesa del
prompt ni una nota en este README: es una aserción sobre el proceso entero, con las rutas
montadas, el orquestador vivo y el episodio escribiéndose.

---

## Mapa de `src/`

```
config.ts            .env de la raíz → config congelada. Nunca imprime una credencial.
types.ts             re-export de shared/contracts.ts + tipos internos (congelados).
safety/              MOTOR DE RED-FLAGS. 9 reglas, ES+EN, puro. + post-filtro de salida.
clients/             coreClient (:3001), coverageClient (:3003), http (nunca lanza),
                     contextCoercion (tolerancia del Contrato 1).
live/                bus de eventos + SSE (Contrato 5).
agent/               systemPrompt, LlmProvider (Bedrock/scripted), guía de intervención.
audio/               STT relay (Deepgram Listen), TTS (Aura-2 → Polly), troceo por frases.
session/             CallSession y construcción del episodio (Contrato 2).
redaction/           redacción de PII antes de persistir el transcript.
orchestrator/        ciclo de vida de la llamada + turnPipeline (el orden que no se negocia).
routes/              health, call (WS + simulate), debug.
cli/                 npm run redflag
```

Lecturas recomendadas, en este orden: `src/safety/rules.ts` →
`src/orchestrator/turnPipeline.ts` (sección 7) → `src/session/episodeBuilder.ts`.

---

## Reglas de la carpeta

- loop-voice **solo edita `voice/`**. Nunca toca `core/`, `dashboard/` ni `coverage/`.
- `shared/` es de **solo lectura** (salvo la nota (d) de arriba, que ya está avisada al grupo).
- **Nunca se habla FHIR.** Se consume el JSON de loop-core.
- **Nunca se llama a Stedi.** Se llama a loop-coverage y se lee su `voiceSummary` **literal**.
- El motor de red-flags **no se mueve a un prompt**, ni ahora ni después del hackathon.
