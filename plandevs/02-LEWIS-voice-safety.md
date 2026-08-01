# Loop — Brief de Lewis
## Plataforma B: `loop-voice` — Agente de voz y motor de seguridad (Deepgram)

> **Tu misión en una frase:** que alguien en pánico pueda hablar y ser escuchado con contexto real — y que el sistema sepa **cuándo callarse y mandar a llamar al 911**.

Tienes la parte más visible del demo (60 de los 180 segundos) y la más difícil técnicamente. También tienes la pieza que los jueces van a interrogar más: **el motor de red-flags**. Constrúyelo primero. Literalmente antes que la voz.

---

## 1. Contexto del producto (léelo una vez)

**Loop** es un compañero de voz para gente con trastorno de ansiedad/pánico. El paciente llama en medio de un episodio. El agente ya conoce su baseline porque los datos de su wearable llevan semanas entrando a un registro FHIR (lo construye Kiwis). El agente **no diagnostica**: refleja datos y lee el plan de cuidado que escribió su clínico. Al final el episodio se escribe de vuelta como `Encounter` estructurado.

**El posicionamiento del pitch:** *contextualizar, nunca diagnosticar*. El agente jamás dice "estás teniendo un ataque de pánico". Dice *"tu frecuencia cardiaca está en 118, tu baseline es 68. Tu plan de cuidado dice empezar con respiración de caja — ¿lo hacemos juntos?"*. Eso es una decisión de producto, no una limitación. Enmárcalo así.

**Hackathon Y Combinator × Medplum.** Tres sponsors: Deepgram (tú), Medplum (Kiwis), Stedi (Carlos).

---

## 2. Qué construyes / Qué NO construyes

### Construyes ✅
- **Motor de red-flags determinista** — reglas hardcodeadas que corren **antes** del LLM, en cada turno del paciente. Esto se construye primero y se demuestra explícitamente.
- **Loop de voz con Deepgram**: Voice Agent API, Nova-3 Medical para STT, TTS de baja latencia.
- **Capa de contextualización**: llama a `GET :3001/api/v1/context/:patientId` (Kiwis), arma el prompt del sistema con biometría real + care plan, conversa.
- **Guía de intervenciones**: leer el `voiceScript` del care plan y acompañar al paciente por la respiración de caja / grounding, con timing real.
- **Trigger de coverage**: cuando la conversación llega a una actividad del plan con `costItem`, llamar a `POST :3003/api/v1/coverage/check` (Carlos) y **leer el `voiceSummary` literal**.
- **Write-back**: al terminar la llamada, `POST :3001/api/v1/episodes` con transcript, intervenciones y outcome.
- **Stream SSE en vivo** (`GET :3002/api/v1/live/stream`) para que el dashboard de Carlos muestre la conversación en tiempo real durante el demo.
- **Redacción de PII** en el transcript antes de persistirlo (Deepgram lo hace).

### NO construyes ❌
- Nada de FHIR ni Medplum directo. Consumes el JSON de Kiwis. **Nunca hables FHIR.**
- Nada de Stedi. Llamas al endpoint de Carlos y lees su `voiceSummary`. No parsees 271.
- Nada de dashboard ni React. Emites eventos SSE; Carlos los pinta.
- Ordenamiento de farmacia, recomendación de suplementos, recomendación de medicamentos. **Fuera de alcance, y es parte del pitch decirlo.**
- Telefonía real (Twilio, PSTN). Usa el micrófono del navegador o una app CLI. Un número telefónico real es un pozo de tiempo y no suma al demo.

---

## 3. Constantes compartidas (idénticas en los 3 briefs)

```
# Puertos
3000  loop-dashboard   (Carlos)
3001  loop-core        (Kiwis)
3002  loop-voice       (Lewis)   ← tú
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
    contracts.ts        ← tipos TypeScript, fuente única de verdad. La escribe Kiwis en T0.
    constants.ts
    fixtures/
      context.happy.json
      context.redflag.json
      coverage.covered.json
      episode.sample.json
      outcomes.sample.json
  core/          (Kiwis)    :3001
  voice/         (Lewis)    :3002   ← tu carpeta
  dashboard/     (Carlos)   :3000
  coverage/      (Carlos)   :3003
  ops/
    .env.example
    demo-runbook.md
```

**Regla de oro:** tu Claude Code **solo edita `voice/`**. `shared/` es de solo lectura para ti — cualquier cambio va por PR + aviso a los tres. Nunca toques `core/`, `dashboard/` ni `coverage/`.

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

> **`voiceSummary` es el campo crítico.** Lo lees **literal**, sin pasarlo por el LLM. Menos latencia y cero riesgo de que el modelo invente un copago.

### Contrato 4 — Lecturas del dashboard · **sirve Kiwis → consume Carlos**

```
GET /api/v1/patients/:id/summary
GET /api/v1/patients/:id/observations?metric=heartRate&from=&to=&bucket=1h
GET /api/v1/patients/:id/episodes
GET /api/v1/patients/:id/outcomes
```

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

### Contrato 5 — Live event stream · **sirve Lewis → consume Carlos**

```
GET http://localhost:3002/api/v1/live/stream        (SSE, text/event-stream)
```

Eventos: `call.started` · `transcript.turn` · `biometrics.tick` · `safety.escalation` · `coverage.check` · `call.ended` · `episode.written`

```
event: call.started
data: {"callId":"call-8f2a","patientId":"loop-demo-patient-001","at":"..."}

event: transcript.turn
data: {"callId":"call-8f2a","speaker":"patient","text":"...","at":"..."}

event: safety.escalation
data: {"callId":"call-8f2a","rule":"RF-01-CHEST-PAIN-RADIATING","action":"advised-911","at":"..."}

event: coverage.check
data: {"callId":"call-8f2a","checkId":"cov-1a2b","status":"covered","copayCents":2500,"at":"..."}

event: episode.written
data: {"callId":"call-8f2a","encounterId":"enc-0042","at":"..."}
```

### Contrato 6 — Control de demo · **sirve Kiwis → dispara Carlos desde el dashboard**

```
POST /api/v1/demo/spike     { "patientId": "...", "profile": "panic" | "cardiac-redflag" | "calm" }
POST /api/v1/demo/reset
```

---

## 5. El motor de red-flags — constrúyelo PRIMERO

Esto es lo que decide si el demo aterriza o se muere. Los jueces de health-tech van a preguntar por esto antes que por nada.

**Requisito no negociable: es determinista y corre ANTES del LLM.** No es una instrucción en el prompt. Es un `if` en el código, evaluado en cada turno del paciente, cuyo resultado puede cortar la llamada sin que el modelo se entere.

### Arquitectura del turno

```
audio del paciente
   ↓
Deepgram STT (Nova-3 Medical) → texto del turno
   ↓
┌─────────────────────────────────────────┐
│  redFlagEngine.evaluate(text, biometrics) │  ← DETERMINISTA. Sin LLM.
└─────────────────────────────────────────┘
   ↓ triggered?
   ├── SÍ  → TTS con guion fijo de escalación. Termina la llamada.
   │         Emite SSE safety.escalation. Escribe episodio con outcome escalated-*.
   │         ⚠️ El LLM NUNCA ve este turno.
   └── NO  → LLM con contexto de Medplum → TTS → siguiente turno
```

### Tabla de reglas

| ID | Disparador | Acción |
|---|---|---|
| `RF-01-CHEST-PAIN-RADIATING` | dolor de pecho que irradia a brazo / mandíbula / espalda | 911 |
| `RF-02-SYNCOPE` | desmayo, "me desmayé", pérdida de conciencia | 911 |
| `RF-03-UNILATERAL-WEAKNESS` | debilidad o entumecimiento de un solo lado | 911 |
| `RF-04-SPEECH-FACIAL` | habla arrastrada, caída facial | 911 |
| `RF-05-THUNDERCLAP-HEADACHE` | "el peor dolor de cabeza de mi vida", inicio súbito | 911 |
| `RF-06-DYSPNEA-AT-REST` | no puede terminar frases, dificultad respiratoria en reposo | 911 |
| `RF-07-SELF-HARM` | ideación suicida, intención de autolesión | **988**, no 911 — conectar con línea de crisis |
| `RF-08-BIOMETRIC-ENVELOPE` | HR > 150, HR < 40, RR > 32, SpO2 < 92 (del `safetyEnvelope`) | 911 |
| `RF-09-COMBINED` | dolor de pecho **+** biometría fuera de envelope | 911, prioridad máxima |

### Implementación
- Keyword/regex matching en español **e inglés** (el demo puede ser en cualquiera de los dos — decidan cuál en T0 y prueben ambos si da tiempo).
- Cada regla tiene su ID. **Se loguea qué regla disparó.** Los jueces van a querer verlo.
- Guiones de escalación **fijos, hardcodeados**. Nunca generados por LLM:
  - 911: *"Lo que me estás describiendo necesita atención médica inmediata. Por favor cuelga y llama al 911 ahora. No soy un sustituto de atención de emergencia."*
  - 988: *"Quiero conectarte con alguien ahora mismo. La línea 988 tiene personas disponibles 24/7. ¿Te quedas conmigo mientras marcas?"*
- Un test suite con ~30 frases de entrada, positivas y negativas. **Debe correr en CI o al menos con `npm test` antes del demo.**

### La inversión lógica que tienes que respetar

> Biometría normal es motivo para **tranquilizar y desescalar**, **nunca** para *descartar* una emergencia.

Un paciente de 40 años con historia cardiaca limpia puede tener un evento cardiaco, y se va a presentar muy parecido a un ataque de pánico. El sistema **nunca** infiere "historia sana + diagnóstico previo de ansiedad → esto es ansiedad". Descartar es trabajo de la regla de red-flag y de un humano. Que esto quede explícito en tu prompt del sistema y en el pitch.

---

## 6. Setup hora 0 (tuyo, personal — 30 min)

1. Cuenta en [Deepgram](https://console.deepgram.com) → API key. (El crédito gratis alcanza de sobra.)
2. Revisar docs de **Voice Agent API** — es la ruta rápida: te da STT + LLM + TTS en un solo websocket. Alternativa manual: Nova-3 Medical STT + tu LLM + Deepgram Aura TTS por separado (más control, más trabajo).
3. Decidir con el equipo: **¿demo en español o inglés?** Nova-3 Medical está optimizado para inglés clínico. Si el demo es en inglés, mejor calidad de STT. Decídanlo en T0.
4. Clonar repo, crear `voice/`, esperar a que Kiwis publique `shared/contracts.ts`.
5. Micrófono probado en la laptop que se va a usar en el escenario. **La misma laptop.**

---

## 7. Plan por fases

### Fase 0 — T0 → T0+45min · Congelar contratos (los TRES juntos)
- Revisar la sección 4 en voz alta. Ajustar ahora, no después.
- Confirmar idioma del demo.
- **DoD:** puedes importar `shared/contracts.ts` y compila.

### Fase 1 — T0+45min → T+4h · Motor de red-flags, sin voz
Nada de audio todavía. Solo texto.

- `redFlagEngine.evaluate(transcriptText, biometrics, safetyEnvelope) → RedFlagResult`
- Las 9 reglas implementadas.
- Test suite con ~30 frases (positivas y negativas), corriendo verde.
- CLI: `npm run redflag "me duele el pecho y se me va al brazo"` → imprime `RF-01-CHEST-PAIN-RADIATING → 911`

**DoD Fase 1:** puedes demostrar el motor de seguridad completo desde la terminal, sin voz. Si todo lo demás falla, esto solo ya es un pitch defendible.

### Fase 2 — T+4h → T+10h · Loop de voz con mocks
- Websocket de Deepgram Voice Agent funcionando: hablas, responde.
- `USE_MOCKS=true` → lees el contexto desde `shared/fixtures/context.happy.json`. **No dependes de que Kiwis haya terminado.**
- Prompt del sistema armado con biometría real del fixture. Que la primera respuesta diga números concretos: *"tu frecuencia cardiaca está en 118, tu baseline es 68"*.
- El motor de red-flags interceptando **cada** turno antes del LLM.
- Servidor SSE en `:3002/api/v1/live/stream` emitiendo `call.started` y `transcript.turn`. **Avísale a Carlos en cuanto emita algo** — es su dependencia.

**DoD Fase 2:** conversación de voz de 60 segundos con contexto biométrico. Carlos ve el transcript aparecer en su dashboard.

### Fase 3 — T+10h → T+16h · Integraciones reales
- `USE_MOCKS=false` → `GET :3001/api/v1/context/...` real de Kiwis.
- Guía de intervención: leer `voiceScript` de `cp-act-1` y acompañar la respiración con timing real (pausas de 4 segundos de verdad). **Esto es lo que hace que el demo se sienta humano.**
- Preguntar y capturar `patientReportedRelief` (0–10) y `severitySelfReported`.
- Trigger de coverage: al llegar a una actividad con `costItem` → `POST :3003/coverage/check` → leer `voiceSummary` **literal**.
- `POST :3001/api/v1/episodes` al colgar.
- Redacción de PII en el transcript antes de mandarlo.

**DoD Fase 3:** una llamada completa produce un `Encounter` en Medplum y el dashboard de Carlos lo refleja.

### Fase 4 — T+16h → T+20h · Latencia y el camino de red-flag
- **Latencia objetivo: <800ms de fin-de-habla a inicio-de-respuesta.** Alguien en pánico no espera 3 segundos.
  - Precarga el contexto al iniciar la llamada, no por turno.
  - Streaming de TTS: empieza a hablar antes de que el LLM termine.
  - Frase puente ("déjame ver tus datos...") mientras llega la respuesta.
- Camino completo de red-flag probado en vivo: `POST :3001/demo/spike {profile:"cardiac-redflag"}` → llamas → dices el síntoma → escalación inmediata.
- Sync #2 con los tres.

### Fase 5 — T+20h → demo · Endurecer
- Reintentos y timeouts en cada llamada saliente. Si `/context` no responde en 2s, usa el último contexto conocido y sigue. **La llamada nunca se cae.**
- Si `/coverage/check` falla: *"no pude verificar tu cobertura ahora mismo, tu equipo de cuidado puede confirmarlo"*. Nunca inventes un número.
- Disclosure al inicio de cada llamada: *"no soy un sustituto de atención de emergencia"*.
- **Ensayar el guion de la llamada 10 veces.** Sabes exactamente qué vas a decir en el escenario.

---

## 8. `voice/CLAUDE.md` — pega esto en tu carpeta

```markdown
# loop-voice

Agente de voz + motor de seguridad para Loop (hackathon YC × Medplum).
Deepgram Voice Agent API. Puerto 3002.

## Reglas
- SOLO edito archivos dentro de `voice/`. Nunca toco `core/`, `dashboard/` ni `coverage/`.
- `../shared/contracts.ts` es de solo lectura.
- NUNCA hablo FHIR. Consumo el JSON de loop-core (:3001).
- NUNCA llamo a Stedi. Llamo a loop-coverage (:3003) y leo su campo
  `voiceSummary` LITERAL, sin pasarlo por el LLM.

## Regla de seguridad — la más importante del repo
El motor de red-flags es DETERMINISTA y corre ANTES de cualquier llamada al LLM.
No es una instrucción de prompt. Es código.
Si `redFlagEngine.evaluate()` devuelve triggered=true:
  - el LLM NO se invoca para ese turno
  - se reproduce un guion de escalación HARDCODEADO
  - la llamada termina
  - se registra el ID de la regla que disparó
Nunca muevo esta lógica a un prompt. Nunca dejo que el LLM decida si escalar.

## Postura del agente
- Contextualiza, nunca diagnostica. Nunca digo "estás teniendo un ataque de pánico".
- Digo qué está haciendo el cuerpo y qué dice el care plan escrito por su clínico.
- Biometría normal → tranquilizar y desescalar. NUNCA para descartar una emergencia.
- Cero recomendaciones de medicamentos o suplementos. Cero órdenes autónomas.

## Stack
- TypeScript + Node
- @deepgram/sdk (Voice Agent API, Nova-3 Medical)
- SSE para el stream en vivo hacia el dashboard

## Prioridades
1. Motor de red-flags con tests verdes.
2. Latencia <800ms fin-de-habla → inicio-de-respuesta.
3. Que la llamada nunca se caiga aunque un servicio downstream falle.
```

---

## 9. Primer prompt para tu Claude Code

```
Lee plan/02-LEWIS-voice-safety.md completo, en especial la sección 5.

Estamos en la Fase 1. NO implementes nada de audio ni de Deepgram todavía.

Construye en voice/src/safety/ un motor de red-flags determinista:

  evaluate(input: { transcriptText: string; biometrics: CurrentBiometrics;
                    safetyEnvelope: SafetyEnvelope })
    => { triggered: boolean; ruleId: string | null;
         action: "advise-911" | "advise-988" | "connect-human" | null;
         script: string | null }

Requisitos:
- Las 9 reglas de la tabla de la sección 5, cada una con su ID exacto.
- Matching por keyword/regex en español e inglés.
- Guiones de escalación hardcodeados como constantes. Nunca generados.
- Función pura, sin I/O, sin llamadas de red, sin LLM. Debe ser testeable en aislamiento.
- Test suite con al menos 30 casos: positivos por cada regla, y negativos
  que NO deben disparar (ej. "me duele un poco la cabeza",
  "siento el corazón acelerado" sin biometría fuera de envelope).
- CLI: `npm run redflag "<frase>"` que imprime el resultado.

Los tipos vienen de ../shared/contracts.ts. No toques carpetas fuera de voice/.
```

---

## 10. Checkpoints de integración

| Checkpoint | Cuándo | Qué se prueba | Tu responsabilidad |
|---|---|---|---|
| **Contract freeze** | T0+45min | `shared/contracts.ts` compila para los tres | Confirmar que el shape del episodio te sirve |
| **SSE vivo** | T+8h | Carlos recibe eventos de tu stream | Emitir aunque sean eventos falsos |
| **Sync #1** | T+16h | Llamada real → contexto real de Kiwis → episodio escrito | Que la llamada no se caiga |
| **Sync #2** | T+20h | Red-flag en vivo + coverage en vivo | Ensayar ambos caminos 3 veces |
| **Demo lock** | T+24h | 3 ensayos completos sin tocar código | Guion memorizado |

**Protocolo de cambio de contrato:** mensaje al grupo → PR a `shared/` → los tres hacen pull → confirmación de los tres.

---

## 11. Tu momento en el demo (3 min)

- **0:10–1:10 (60s, el bloque más largo)** — La llamada en vivo. El paciente describe síntomas, el agente responde con contexto biométrico real y lo guía por una intervención del care plan. El transcript se ve fluir en el dashboard.
- **1:40–2:00** — **El demo de seguridad.** Segunda llamada, síntomas de red-flag, escalación inmediata. *"Muestra que el agente sabe cuándo parar."* Veinte segundos, pero es el momento que hace que un juez clínico se incline hacia adelante.
- **1:10–1:40** — El coverage check dispara desde tu conversación (lo pinta Carlos).

**Consejo:** en el bloque de 60s, la primera frase del agente tiene que incluir un número concreto del baseline. *"Tu ritmo está en 118, tu promedio es 68"*. Eso es lo que prueba que hay datos reales atrás y no un chatbot.

---

## 12. Riesgos y plan B

| Riesgo | Plan B |
|---|---|
| Voice Agent API da problemas | Camino manual: Nova-3 Medical STT + LLM + Aura TTS por separado. Más código, más control. **Decide esto en T+6h, no en T+20h.** |
| Latencia >2s, el demo se siente muerto | Precarga contexto al inicio, frase puente mientras llega el LLM, streaming de TTS. Si sigue mal: reduce el prompt del sistema, es lo que más pesa. |
| El micrófono falla en el escenario | Graba un audio de respaldo de la llamada completa. Si el mic muere, reproduces el audio y el sistema procesa igual. Ten esto listo en T+22h. |
| El LLM dice algo que suena a diagnóstico | Post-filtro determinista sobre la salida del LLM: lista de frases prohibidas ("estás teniendo", "es un ataque de", "no es nada grave"). Si matchea, se reemplaza por una frase segura. |
| Ruido del hackathon rompe el STT | Micrófono de diadema, no el de la laptop. Consíguelo antes. |

---

## 13. Definition of Done — tu plataforma

- [ ] Motor de red-flags con las 9 reglas y ~30 tests verdes
- [ ] El LLM demostrablemente **no** se invoca cuando una regla dispara
- [ ] Guiones de escalación hardcodeados (911 y 988 separados)
- [ ] Loop de voz Deepgram funcionando con mic real
- [ ] Contexto real de `:3001` armando el prompt del sistema
- [ ] La primera respuesta del agente cita números reales de baseline
- [ ] Guía de intervención con timing real de respiración
- [ ] Coverage check disparado desde la conversación, `voiceSummary` leído literal
- [ ] `POST /episodes` al colgar, con transcript redactado
- [ ] SSE `/live/stream` emitiendo los 7 tipos de evento
- [ ] Latencia <800ms fin-de-habla → inicio-de-respuesta
- [ ] La llamada sobrevive a que `:3001` o `:3003` estén caídos
- [ ] Disclosure de "no sustituye atención de emergencia" al inicio
- [ ] Audio de respaldo grabado por si el mic falla
