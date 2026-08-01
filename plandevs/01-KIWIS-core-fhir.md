# Loop — Brief de Kiwis
## Plataforma A: `loop-core` — Backbone de datos, FHIR y automatización (Medplum)

> **Tu misión en una frase:** ser la fuente de verdad. Todo lo que el agente de voz sabe del paciente y todo lo que queda registrado después de un episodio pasa por ti.

Eres la dependencia de los otros dos. Por eso tu prioridad #1 no es "que funcione bien", es **que exista rápido** — aunque sea mintiendo. Ver la sección [Fase 1: Mocks primero](#fase-1--t0--t4-mocks-primero-bloquea-a-todos).

---

## 1. Contexto del producto (léelo una vez)

**Loop** es un compañero de voz para gente con trastorno de ansiedad/pánico. El paciente llama en medio de un episodio. El agente ya conoce su baseline porque los datos de su wearable llevan semanas entrando a un registro FHIR. El agente **no diagnostica**: refleja datos y lee el plan de cuidado que escribió su clínico. Al final, el episodio se escribe de vuelta como `Encounter` estructurado, y con el tiempo el sistema muestra qué intervención correlaciona con episodios más cortos.

Eso último — el **loop cerrado** intervención → resultado medido — es el diferenciador del pitch. Y vive en tu plataforma.

**Hackathon Y Combinator × Medplum.** Se usan los tres sponsors: Deepgram (Lewis), Medplum (tú), Stedi (Carlos).

---

## 2. Qué construyes / Qué NO construyes

### Construyes ✅
- Proyecto Medplum configurado, con credenciales de servicio y un `Patient` demo sembrado.
- **Generador de dataset**: 30 días de baseline realista (HR, HRV, respiratory rate, sleep, activity) como `Observation` FHIR + un "episode spike" guionizado.
- **Servicio HTTP `loop-core` (`:3001`)** que expone los contratos 1, 2, 4 y 6 de abajo. Es un gateway sobre Medplum — nadie más habla FHIR directo.
- Recursos FHIR sembrados: `Patient`, `Condition` (ansiedad), `CarePlan` (autorado por clínico ficticio), `MedicationStatement`, 3 `Encounter` históricos de episodios previos.
- **Cálculo de baseline y deltas** (media, desviación estándar, cuántas SD por encima está el valor actual). Esto es lo que hace que la voz suene inteligente.
- **Agregado de outcomes**: por cada intervención del care plan, cuántas veces se intentó y cuál fue la duración media del episodio. El gráfico estrella de Carlos sale de aquí.
- **Medplum Bot + Subscription**: al crearse un `Encounter` de episodio, dispara un Bot. Mínimo: que etiquete el Encounter y registre el evento. Ideal: que llame al servicio de coverage de Carlos.
- **Endpoints de control de demo** (`/demo/spike`, `/demo/reset`). Sin esto el demo en vivo es una ruleta.

### NO construyes ❌
- Nada de Deepgram, STT, TTS ni LLM conversacional → **Lewis**.
- Nada de Stedi ni lógica de elegibilidad → **Carlos**.
- Nada de dashboard, React ni gráficos → **Carlos**. Tú entregas el JSON agregado, él lo pinta.
- Ingesta live de HealthKit / Bluetooth. **Está fuera de alcance a propósito** — se replay-ea un dataset pregrabado. Un sensor que falla en el escenario mata el demo.
- Las reglas de red-flag. Tú **publicas el `safetyEnvelope`** (los umbrales) en el contexto; Lewis las evalúa.

---

## 3. Constantes compartidas (idénticas en los 3 briefs)

```
# Puertos
3000  loop-dashboard   (Carlos)
3001  loop-core        (Kiwis)   ← tú
3002  loop-voice       (Lewis)
3003  loop-coverage    (Carlos)

# IDs fijos del demo
LOOP_PATIENT_ID       = "loop-demo-patient-001"
LOOP_PRACTITIONER_ID  = "loop-demo-clinician-001"
LOOP_CAREPLAN_ID      = "loop-demo-careplan-001"

# Variables de entorno (mismos nombres en los 3 servicios)
MEDPLUM_BASE_URL=https://api.medplum.com/
MEDPLUM_CLIENT_ID=
MEDPLUM_CLIENT_SECRET=
MEDPLUM_PROJECT_ID=
DEEPGRAM_API_KEY=
STEDI_API_KEY=
STEDI_TEST_PAYER_ID=
ANTHROPIC_API_KEY=
LOOP_CORE_URL=http://localhost:3001
LOOP_VOICE_URL=http://localhost:3002
LOOP_COVERAGE_URL=http://localhost:3003
LOOP_PATIENT_ID=loop-demo-patient-001
USE_MOCKS=true          # ← la palanca que hace la integración trivial
```

**Regla de `USE_MOCKS`:** cada servicio, cuando llama a otro, respeta esta variable. En `true` lee de `shared/fixtures/`. En `false` hace HTTP real. Nadie se bloquea nunca.

### Estructura del repo (uno solo, compartido)

```
loop/
  shared/
    contracts.ts        ← tipos TypeScript, fuente única de verdad. LO ESCRIBES TÚ en T0.
    constants.ts        ← IDs, puertos, códigos SNOMED/CPT
    fixtures/           ← JSON golden. Mocks y reales deben coincidir con esto.
      context.happy.json
      context.redflag.json
      coverage.covered.json
      episode.sample.json
      outcomes.sample.json
  core/          (Kiwis)    :3001   ← tu carpeta
  voice/         (Lewis)    :3002
  dashboard/     (Carlos)   :3000
  coverage/      (Carlos)   :3003
  ops/
    .env.example
    demo-runbook.md
```

**Regla de oro:** tu Claude Code **solo edita `core/`**. `shared/` lo escribes tú en T0 y después se congela — cualquier cambio va por PR + aviso a los tres. Nunca toques `voice/`, `dashboard/` ni `coverage/`.

---

## 4. Contratos de integración (SECCIÓN IDÉNTICA EN LOS 3 BRIEFS)

> Estos contratos se congelan en T0. Si algo tiene que cambiar: se avisa en el grupo, se actualiza `shared/contracts.ts`, y los tres hacen pull. Sin excepciones.

### Contrato 1 — Patient Context · **sirve Kiwis → consume Lewis**

```
GET http://localhost:3001/api/v1/context/:patientId?window=30m
```

```json
{
  "patientId": "loop-demo-patient-001",
  "displayName": "Alex Rivera",
  "age": 34,
  "generatedAt": "2026-08-01T18:22:11Z",
  "baseline": {
    "heartRate":       { "mean": 68,  "sd": 6,   "unit": "bpm" },
    "hrv":             { "mean": 54,  "sd": 11,  "unit": "ms" },
    "respiratoryRate": { "mean": 14,  "sd": 2,   "unit": "breaths/min" },
    "sleepHours":      { "mean": 6.8, "sd": 1.1, "unit": "h" }
  },
  "current": {
    "windowMinutes": 30,
    "heartRate":       { "latest": 118, "max": 126, "trend": "rising",  "unit": "bpm" },
    "hrv":             { "latest": 21,  "min": 18,  "trend": "falling", "unit": "ms" },
    "respiratoryRate": { "latest": 24,  "max": 27,  "trend": "rising",  "unit": "breaths/min" },
    "lastSampleAt": "2026-08-01T18:21:40Z"
  },
  "deltas": {
    "heartRate": { "absolute": 50,  "sdFromBaseline": 8.3 },
    "hrv":       { "absolute": -33, "sdFromBaseline": -3.0 }
  },
  "conditions": [
    { "code": "197480006", "system": "http://snomed.info/sct",
      "display": "Anxiety disorder", "onsetDate": "2023-04-12", "clinicalStatus": "active" }
  ],
  "carePlan": {
    "id": "loop-demo-careplan-001",
    "authoredBy": "Dr. Maya Chen",
    "lastUpdated": "2026-07-02",
    "activities": [
      { "id": "cp-act-1", "order": 1, "type": "breathing",
        "title": "Box breathing",
        "instruction": "4 in, 4 hold, 4 out, 4 hold — 5 cycles",
        "durationMinutes": 4,
        "voiceScript": "Vamos a hacerlo juntos. Inhala cuatro tiempos conmigo..." },
      { "id": "cp-act-2", "order": 2, "type": "grounding",
        "title": "5-4-3-2-1 grounding",
        "instruction": "Name 5 things you see, 4 you can touch...",
        "durationMinutes": 3,
        "voiceScript": "..." },
      { "id": "cp-act-3", "order": 3, "type": "escalation-soft",
        "title": "Message care team",
        "instruction": "Reach out to your clinician for a same-week telehealth visit",
        "costItem": { "serviceType": "telehealth-mental-health", "cptCode": "90834" } }
    ]
  },
  "recentEpisodes": [
    { "encounterId": "enc-0031", "startedAt": "2026-07-28T02:14:00Z", "durationMinutes": 22,
      "peakHeartRate": 121, "interventions": ["cp-act-1"],
      "resolution": "self-resolved", "severitySelfReported": 7 }
  ],
  "medications": [
    { "display": "Sertraline 50mg", "status": "active", "rxnorm": "312938", "coverageCheckable": true }
  ],
  "safetyEnvelope": {
    "heartRateMax": 150,
    "heartRateMin": 40,
    "respiratoryRateMax": 32,
    "spo2Min": 92,
    "note": "Valores fuera del envelope DEBEN disparar escalación determinista ANTES de cualquier llamada al LLM."
  }
}
```

### Contrato 2 — Episode write-back · **sirve Kiwis → llama Lewis**

```
POST http://localhost:3001/api/v1/episodes
```

```json
{
  "patientId": "loop-demo-patient-001",
  "callId": "call-8f2a",
  "startedAt": "2026-08-01T18:20:02Z",
  "endedAt": "2026-08-01T18:34:50Z",
  "outcome": "resolved-with-intervention",
  "escalation": {
    "triggered": false,
    "rule": null,
    "triggeredAt": null,
    "action": null
  },
  "severitySelfReported": 7,
  "interventionsAttempted": [
    { "carePlanActivityId": "cp-act-1", "startedAt": "2026-08-01T18:23:10Z",
      "completed": true, "patientReportedRelief": 6 }
  ],
  "biometricsSnapshot": { "peakHeartRate": 126, "minHrv": 18, "peakRespiratoryRate": 27 },
  "transcript": {
    "redacted": true,
    "turns": [ { "speaker": "patient", "at": "2026-08-01T18:20:05Z", "text": "..." },
               { "speaker": "agent",   "at": "2026-08-01T18:20:11Z", "text": "..." } ]
  },
  "coverageChecks": [
    { "checkId": "cov-1a2b", "serviceType": "telehealth-mental-health",
      "result": "covered", "copayCents": 2500 }
  ]
}
```

`outcome` ∈ `resolved-with-intervention` | `self-resolved` | `escalated-emergency` | `escalated-human` | `abandoned`

**Respuesta:** `201` → `{ "encounterId": "enc-0042", "medplumUrl": "https://app.medplum.com/Encounter/..." }`

### Contrato 3 — Coverage check · **sirve Carlos → llaman Lewis y el Bot de Kiwis**

```
POST http://localhost:3003/api/v1/coverage/check
```

```json
{ "patientId": "loop-demo-patient-001",
  "serviceType": "telehealth-mental-health",
  "cptCode": "90834",
  "requestedBy": "voice-agent",
  "callId": "call-8f2a" }
```

```json
{
  "checkId": "cov-1a2b",
  "checkedAt": "2026-08-01T18:29:40Z",
  "status": "covered",
  "payerName": "Test Payer Inc",
  "planName": "PPO Silver",
  "copayCents": 2500,
  "coinsurancePercent": 0,
  "deductible": { "individualCents": 150000, "metCents": 142000, "remainingCents": 8000 },
  "priorAuthRequired": false,
  "raw271Id": "stedi-271-...",
  "voiceSummary": "Tu sesión de telesalud está cubierta. Tu copago es de 25 dólares y ya cubriste casi todo tu deducible.",
  "latencyMs": 812
}
```

`status` ∈ `covered` | `not-covered` | `needs-auth` | `unknown`

> **`voiceSummary` es el campo crítico.** Lewis lo lee **literal**, sin pasarlo por el LLM. Menos latencia y cero riesgo de que el modelo invente un copago.

### Contrato 4 — Lecturas del dashboard · **sirve Kiwis → consume Carlos**

```
GET /api/v1/patients/:id/summary
GET /api/v1/patients/:id/observations?metric=heartRate&from=&to=&bucket=1h
GET /api/v1/patients/:id/episodes
GET /api/v1/patients/:id/outcomes
```

`/outcomes` — **el gráfico estrella del pitch**:

```json
{
  "byIntervention": [
    { "carePlanActivityId": "cp-act-1", "title": "Box breathing",
      "timesAttempted": 5, "avgEpisodeDurationMinutes": 14, "avgReliefScore": 6.4 },
    { "carePlanActivityId": "cp-act-2", "title": "5-4-3-2-1 grounding",
      "timesAttempted": 3, "avgEpisodeDurationMinutes": 26, "avgReliefScore": 3.1 }
  ],
  "baselineNoInterventionAvgDurationMinutes": 31,
  "episodeCountByWeek": [ { "weekStart": "2026-07-06", "count": 4 }, { "weekStart": "2026-07-13", "count": 2 } ]
}
```

`/observations` devuelve `{ "metric": "heartRate", "unit": "bpm", "points": [{ "t": "...", "v": 68 }] }`.

### Contrato 5 — Live event stream · **sirve Lewis → consume Carlos**

```
GET http://localhost:3002/api/v1/live/stream        (SSE, text/event-stream)
```

Eventos: `call.started` · `transcript.turn` · `biometrics.tick` · `safety.escalation` · `coverage.check` · `call.ended` · `episode.written`

```
event: transcript.turn
data: {"callId":"call-8f2a","speaker":"patient","text":"...","at":"..."}

event: safety.escalation
data: {"callId":"call-8f2a","rule":"RF-01-CHEST-PAIN-RADIATING","action":"advised-911","at":"..."}
```

### Contrato 6 — Control de demo · **sirve Kiwis → dispara Carlos desde el dashboard**

```
POST /api/v1/demo/spike     { "patientId": "...", "profile": "panic" | "cardiac-redflag" | "calm" }
POST /api/v1/demo/reset
```

`profile: "panic"` → inyecta observaciones que suben HR a ~120 y bajan HRV.
`profile: "cardiac-redflag"` → HR fuera del `safetyEnvelope` (>150), para el demo de seguridad.

---

## 5. Setup hora 0 (tuyo, personal — 30 min)

1. Cuenta en [Medplum](https://app.medplum.com) → crear proyecto `loop-hackathon`.
2. `Project Admin → Clients` → crear un ClientApplication → guardar `client_id` / `client_secret`.
3. `npm i -g @medplum/cli` y verificar login.
4. Clonar el repo compartido, crear `core/`.
5. **Escribir `shared/contracts.ts` y `shared/constants.ts`** con los tipos de la sección 4. Avisar en el grupo: *"contratos arriba, hagan pull"*. Esto desbloquea a Lewis y Carlos.
6. Llenar `shared/fixtures/*.json` con exactamente los ejemplos de arriba.

> El paso 5 es literalmente lo primero que tienes que hacer. Antes de escribir una línea de lógica.

---

## 6. Plan por fases

### Fase 0 — T0 → T0+45min · Congelar contratos (los TRES juntos)
- Revisar la sección 4 en voz alta, los tres. Ajustar lo que haga falta **ahora**, no después.
- Crear repo, carpetas, `.env.example`.
- Tú publicas `shared/contracts.ts` + `shared/constants.ts` + `shared/fixtures/`.
- **DoD:** los tres pueden importar `shared/contracts.ts` y compila.

### Fase 1 — T0+45min → T+4h · Mocks primero (bloquea a todos)
Antes de tocar Medplum, levanta `loop-core` en `:3001` devolviendo los fixtures tal cual, hardcodeados.

- `GET /api/v1/context/:id` → `context.happy.json`
- `GET /api/v1/context/:id?profile=redflag` → `context.redflag.json`
- `POST /api/v1/episodes` → responde `201` con un id inventado y hace `console.log` del body
- `GET /api/v1/patients/:id/outcomes` → `outcomes.sample.json`
- `GET /api/v1/patients/:id/observations` → serie sintética
- `POST /api/v1/demo/spike` → cambia una variable en memoria que hace que `/context` devuelva el fixture de spike

**DoD Fase 1:** Lewis puede hacer `curl :3001/api/v1/context/loop-demo-patient-001` y recibir JSON válido. Carlos puede pintar un gráfico. **Avísales en cuanto esté.** Este es tu entregable más importante de todo el hackathon.

### Fase 2 — T+4h → T+10h · Medplum real
- Sembrar `Patient`, `Practitioner`, `Condition`, `CarePlan`, `MedicationStatement`.
- Generador de dataset: 30 días de `Observation`. Usa LOINC:
  - Heart rate `8867-4` · Respiratory rate `9279-1` · HRV `80404-7` · Sleep duration `93832-4`
  - Ritmo circadiano realista: HR baja de noche, sube en la mañana, picos de actividad. Ruido gaussiano sobre la curva.
  - Sembrar 3 episodios históricos con spikes visibles, cada uno con su `Encounter` y su intervención registrada — **necesarios para que el gráfico de outcomes tenga datos el día del demo.**
- Sustituir los mocks por lecturas reales de Medplum, **manteniendo el shape del JSON idéntico**.
- Cálculo real de baseline (media/SD sobre los 30 días) y deltas.

**DoD Fase 2:** `/context` sale de Medplum de verdad y es byte-compatible con el fixture. Los otros dos no notan el cambio.

### Fase 3 — T+10h → T+16h · Write-back, outcomes y Bot
- `POST /episodes` crea un `Encounter` FHIR real con:
  - `Encounter.reasonCode` = ansiedad, `period`, `Encounter.extension` con biometrics snapshot
  - transcript como `DocumentReference` ligado al Encounter
  - intervenciones como `Procedure` o extensiones referenciando `carePlanActivityId`
- Implementar `/outcomes`: agrupa episodios por intervención, calcula duración media y relief medio.
- **Medplum Bot + Subscription**: `criteria: Encounter?type=loop-episode` → Bot que etiqueta el Encounter y (stretch) llama a `POST :3003/api/v1/coverage/check`.

**DoD Fase 3:** Lewis manda un episodio, aparece en Medplum, y el número en el dashboard de Carlos cambia.

### Fase 4 — T+16h → T+20h · Integración y control de demo
- Sync #1 con los tres (ver sección 9).
- `/demo/spike` y `/demo/reset` funcionando y probados 5 veces seguidas.
- **Idempotencia del reset**: después de `/demo/reset` el estado debe quedar exactamente como al inicio. Si el demo se corre dos veces en el escenario, no puede degradarse.

### Fase 5 — T+20h → demo · Endurecer
- Timeouts y fallbacks: si Medplum tarda >2s, `/context` devuelve el último contexto cacheado. **Nunca** dejes colgado al agente de voz.
- Log estructurado de cada request para poder debuggear en vivo.
- Snapshot del proyecto Medplum en JSON, por si hay que re-sembrar en el escenario.

---

## 7. `core/CLAUDE.md` — pega esto en tu carpeta

```markdown
# loop-core

Gateway sobre Medplum para el proyecto Loop (hackathon YC × Medplum).
Fuente de verdad de datos de paciente. Puerto 3001.

## Reglas
- SOLO edito archivos dentro de `core/`. Nunca toco `voice/`, `dashboard/` ni `coverage/`.
- `../shared/contracts.ts` es de solo lectura. Los tipos de respuesta DEBEN
  coincidir exactamente con lo definido ahí. Si algo no cuadra, lo reporto
  al usuario en vez de cambiar el contrato.
- Toda respuesta HTTP debe validar contra los fixtures de `../shared/fixtures/`.
- Nadie fuera de este servicio habla FHIR. Yo traduzco FHIR → JSON simple.

## Stack
- TypeScript + Node + Fastify (o Express)
- @medplum/core, @medplum/fhirtypes
- zod para validar payloads de entrada y salida

## Datos de demo
- Patient ID fijo: loop-demo-patient-001
- Nunca datos de pacientes reales. Todo sintético.

## Prioridades
1. Que los endpoints respondan con el shape correcto (aunque sea mock).
2. Que salgan de Medplum de verdad.
3. Que sean rápidos (<300ms p95) — hay un agente de voz esperando.

## Códigos
LOINC: heart rate 8867-4 | respiratory rate 9279-1 | HRV 80404-7 | sleep 93832-4
SNOMED: anxiety disorder 197480006
CPT: telehealth psychotherapy 90834
```

---

## 8. Primer prompt para tu Claude Code

```
Lee plan/01-KIWIS-core-fhir.md completo y shared/contracts.ts.

Estamos en la Fase 1. Construye el servicio loop-core en core/ con
TypeScript + Fastify en el puerto 3001, sirviendo ÚNICAMENTE mocks
leídos de shared/fixtures/.

Endpoints requeridos:
  GET  /api/v1/context/:patientId
  POST /api/v1/episodes
  GET  /api/v1/patients/:id/summary
  GET  /api/v1/patients/:id/observations
  GET  /api/v1/patients/:id/episodes
  GET  /api/v1/patients/:id/outcomes
  POST /api/v1/demo/spike
  POST /api/v1/demo/reset
  GET  /healthz

Requisitos:
- Cada respuesta se valida con zod contra los tipos de shared/contracts.ts.
- CORS abierto a localhost:3000 y localhost:3002.
- /demo/spike cambia el estado en memoria para que /context devuelva
  context.redflag.json cuando profile="cardiac-redflag".
- Incluye un script `npm run smoke` que hace curl a todos los endpoints
  y falla si alguno no valida.

NO implementes nada de Medplum todavía. NO toques carpetas fuera de core/.
```

---

## 9. Checkpoints de integración

| Checkpoint | Cuándo | Qué se prueba | Tu responsabilidad |
|---|---|---|---|
| **Contract freeze** | T0+45min | `shared/contracts.ts` compila para los tres | Publicarlo |
| **Sync #1** | T+16h | Lewis llama tu `/context` real y escribe un episodio real | Que Medplum responda <500ms |
| **Sync #2** | T+20h | Camino de red-flag + Stedi en vivo + dashboard reacciona | `/demo/spike` con `cardiac-redflag` |
| **Demo lock** | T+24h | 3 ensayos completos sin tocar código | `/demo/reset` limpio entre ensayos |

**Protocolo de cambio de contrato:** mensaje al grupo → PR a `shared/` → los tres hacen pull → confirmación de los tres. Nunca cambies un shape sin avisar; rompes a dos personas a la vez.

---

## 10. Tu momento en el demo (3 min)

- **0:00–0:10** — El dashboard abre mostrando **tus** 30 días de baseline y 3 episodios previos. La frase del pitch es *"estos datos ya existen, solo que no están en ningún lugar útil"*. Si tu dataset se ve sintético y feo, el pitch arranca mal. **Invierte tiempo en que la curva de HR se vea real.**
- **2:20–3:00** — El nuevo episodio aparece escrito en Medplum y la línea de tendencia muestra qué intervención correlaciona con episodios más cortos. Ese gráfico sale de tu `/outcomes`. **Es la frase de cierre del pitch.**

---

## 11. Riesgos y plan B

| Riesgo | Plan B |
|---|---|
| Medplum Bots no despliegan a tiempo | El Bot es un *nice to have*. La ruta principal es Lewis → Carlos directo. Narra el Bot en el pitch. |
| Sembrar 30 días de Observations es lento (miles de recursos) | Usa `Bundle` de tipo `transaction` en lotes de 100. Y baja la resolución: una muestra cada 15 min, no cada minuto. ~2,900 recursos, suficiente. |
| Medplum lento en el escenario (wifi de hackathon) | Cachea `/context` en memoria al arrancar. Flag `SERVE_FROM_CACHE=true` que se activa si hay que demostrar offline. **Prepara esto antes, no en el escenario.** |
| `/outcomes` sin datos suficientes | Los 3 episodios históricos sembrados son obligatorios, no opcionales. Sin ellos el gráfico está vacío y se cae el cierre del pitch. |

---

## 12. Definition of Done — tu plataforma

- [ ] `shared/contracts.ts` publicado y compilando para los tres (T0+45min)
- [ ] `loop-core` responde los 8 endpoints con mocks válidos
- [ ] Proyecto Medplum con Patient, Condition, CarePlan, Medication sembrados
- [ ] 30 días de Observations con curva realista + 3 episodios históricos
- [ ] `/context` sale de Medplum real, byte-compatible con el fixture
- [ ] `POST /episodes` crea un `Encounter` FHIR real y devuelve su ID
- [ ] `/outcomes` devuelve datos reales que producen un gráfico con señal
- [ ] Subscription + Bot disparando al crearse un episodio
- [ ] `/demo/spike` y `/demo/reset` probados 5 veces seguidas sin degradar
- [ ] Fallback a caché si Medplum tarda >2s
