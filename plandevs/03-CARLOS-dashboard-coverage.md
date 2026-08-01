# Loop — Brief de Carlos
## Plataforma C: `loop-dashboard` + `loop-coverage` — Vista clínica y la pregunta del dinero (Stedi)

> **Tu misión en una frase:** hacer visible el loop cerrado. Eres el primer y el último plano del demo — abres el pitch y lo cierras.

Tienes dos piezas: el **dashboard clínico** (`:3000`), que es lo único que el público ve durante 80 de los 180 segundos, y el **servicio de cobertura** (`:3003`), que envuelve Stedi y responde la pregunta que todo paciente realmente tiene.

---

## 1. Contexto del producto (léelo una vez)

**Loop** es un compañero de voz para gente con trastorno de ansiedad/pánico. El paciente llama en medio de un episodio. El agente ya conoce su baseline porque los datos de su wearable llevan semanas entrando a un registro FHIR (Kiwis). El agente **no diagnostica**: refleja datos y lee el plan de cuidado del clínico (Lewis). Al final el episodio se escribe de vuelta como `Encounter` estructurado.

**El diferenciador del pitch es el loop cerrado**: intervención → resultado medido. *"Todos están construyendo escribas de IA. Casi nadie está construyendo el feedback loop que te dice si la intervención funcionó."* Ese gráfico es tuyo. Es la frase de cierre.

**Hackathon Y Combinator × Medplum.** Tres sponsors: Deepgram (Lewis), Medplum (Kiwis), Stedi (tú).

---

## 2. Qué construyes / Qué NO construyes

### Construyes ✅

**`loop-coverage` (`:3003`)** — microservicio de elegibilidad
- Envuelve la API de eligibility de Stedi (270/271). Una llamada real, en vivo, en el escenario.
- Traduce el 271 crudo a un JSON simple y a un **`voiceSummary`** en lenguaje natural que Lewis lee literal.
- Lo consumen dos clientes: el agente de voz (síncrono, a mitad de llamada) y el Bot de Medplum de Kiwis (asíncrono, post-encuentro).

**`loop-dashboard` (`:3000`)** — vista clínica
- Header del paciente: nombre, edad, condición activa, medicación, clínico tratante.
- **Gráfico de baseline de 30 días** (HR, HRV, respiratory rate) con los episodios marcados encima.
- **Gráfico de outcomes por intervención** — el que cierra el pitch.
- **Panel de llamada en vivo**: transcript en tiempo real vía SSE de Lewis, biometría subiendo, badge de escalación si dispara una red-flag.
- **Tarjeta de cobertura**: aparece cuando el coverage check dispara, con copago y deducible.
- **Panel de control de demo**: botones que llaman a `/demo/spike` y `/demo/reset` de Kiwis. Sin esto el demo en vivo es una ruleta.

### NO construyes ❌
- Nada de FHIR ni Medplum directo. Consumes los endpoints de Kiwis. **Nunca hables FHIR desde el frontend.**
- Nada de Deepgram, STT ni TTS. Consumes el SSE de Lewis.
- Nada de lógica de red-flags. Solo **pintas** el evento `safety.escalation` que emite Lewis.
- Elegibilidad para suplementos. **Aquí está el arreglo más importante del concepto original:** los seguros casi nunca cubren suplementos, así que apuntar Stedi ahí devuelve "no cubierto" para todo y no ayuda a nadie. Apúntalo a algo con respuesta real: *¿está cubierta la visita de telesalud, cuál es el copago, se cumplió el deducible, sigue vigente la receta?* Misma API, resultado que sí sirve.

---

## 3. Constantes compartidas (idénticas en los 3 briefs)

```
# Puertos
3000  loop-dashboard   (Carlos)  ← tú
3001  loop-core        (Kiwis)
3002  loop-voice       (Lewis)
3003  loop-coverage    (Carlos)  ← tú

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
  voice/         (Lewis)    :3002
  dashboard/     (Carlos)   :3000   ← tu carpeta
  coverage/      (Carlos)   :3003   ← tu carpeta
  ops/
    .env.example
    demo-runbook.md
```

**Regla de oro:** tu Claude Code **solo edita `dashboard/` y `coverage/`**. `shared/` es de solo lectura para ti — cualquier cambio va por PR + aviso a los tres. Nunca toques `core/` ni `voice/`.

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
  "escalation": { "triggered": false, "rule": null, "triggeredAt": null, "action": null },
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

> **`voiceSummary` es el campo crítico y es tuyo.** Lewis lo lee **literal**, sin pasarlo por el LLM. Menos latencia y cero riesgo de que el modelo invente un copago. Redáctalo con cuidado: es una de las frases que el público va a escuchar.

### Contrato 4 — Lecturas del dashboard · **sirve Kiwis → consume Carlos**

```
GET /api/v1/patients/:id/summary
GET /api/v1/patients/:id/observations?metric=heartRate&from=&to=&bucket=1h
GET /api/v1/patients/:id/episodes
GET /api/v1/patients/:id/outcomes
```

`/observations` → `{ "metric": "heartRate", "unit": "bpm", "points": [{ "t": "...", "v": 68 }] }`

`/outcomes` — **tu gráfico estrella**:

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

event: biometrics.tick
data: {"callId":"call-8f2a","heartRate":121,"hrv":19,"respiratoryRate":26,"at":"..."}

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

## 5. Setup hora 0 (tuyo, personal — 40 min)

1. Cuenta en [Stedi](https://www.stedi.com) → API key de sandbox. **Hazlo lo antes posible** — el alta puede tardar y es tu única dependencia externa bloqueante.
2. Identificar el **payer de prueba** del sandbox de Stedi y un miembro de prueba válido (member ID, fecha de nacimiento, nombre). Guárdalos en `.env` como `STEDI_TEST_PAYER_ID`, `STEDI_TEST_MEMBER_ID`, etc.
3. **Haz una llamada 270/271 con `curl` antes de escribir cualquier código.** Guarda la respuesta cruda en `coverage/fixtures/stedi-271-raw.json`. Si el sandbox se cae el día del demo, esta respuesta es tu red de seguridad.
4. Clonar repo, crear `dashboard/` y `coverage/`.
5. Esperar el `shared/contracts.ts` de Kiwis.

> El paso 3 es el más importante de tu hora 0. Una llamada real capturada temprano vale más que cualquier cantidad de código.

---

## 6. Plan por fases

### Fase 0 — T0 → T0+45min · Congelar contratos (los TRES juntos)
- Revisar la sección 4 en voz alta. Ajustar ahora, no después.
- **DoD:** puedes importar `shared/contracts.ts` y compila.

### Fase 1 — T0+45min → T+4h · Coverage service con Stedi real
Empieza por aquí, no por el dashboard. Es tu única dependencia externa y quieres saber si funciona **hoy**, no mañana.

- `POST :3003/api/v1/coverage/check` → llamada real a Stedi 270 → parsear 271.
- Mapear a la respuesta del Contrato 3.
- **Redactar el `voiceSummary`.** Frase corta, en primera persona hacia el paciente, con el copago y el deducible en lenguaje humano. Sin jerga de seguros.
- Modo `USE_MOCKS=true` → devuelve `shared/fixtures/coverage.covered.json`.
- Fallback: si Stedi falla o tarda >3s, devuelve `status: "unknown"` con un `voiceSummary` honesto (*"no pude verificar tu cobertura ahora mismo"*). **Nunca inventes un número.**

**DoD Fase 1:** `curl -X POST :3003/api/v1/coverage/check` devuelve un copago real de Stedi. **Avísale a Lewis en cuanto esté** — es su dependencia.

### Fase 2 — T+4h → T+10h · Dashboard esqueleto con mocks
- Next.js (App Router) + Tailwind. Usa componentes de **Medplum React** donde aporten — es sponsor y los jueces lo notan — pero no te pelees con ellos para los gráficos. Recharts para las series.
- Consumiendo los mocks de Kiwis en `:3001` (ya deberían estar arriba desde T+4h).
- Vistas:
  - Header del paciente (`/summary`)
  - Gráfico de 30 días de HR con bandas de baseline y episodios marcados (`/observations`, `/episodes`)
  - Gráfico de outcomes por intervención (`/outcomes`)
  - Panel de control de demo (botones → `/demo/spike`, `/demo/reset`)

**DoD Fase 2:** el dashboard abre y se ve como un producto real con datos mock. **Este es tu primer plano del demo — que se vea bien importa tanto como que funcione.**

### Fase 3 — T+10h → T+16h · Panel en vivo (SSE de Lewis)
- Conectar a `GET :3002/api/v1/live/stream`.
- Transcript en tiempo real, burbujas paciente/agente, auto-scroll.
- Biometría en vivo subiendo mientras la llamada avanza.
- **Badge rojo grande de escalación** cuando llega `safety.escalation`, mostrando el ID de la regla. Los jueces quieren ver que fue una regla, no un modelo.
- **Tarjeta de cobertura** al llegar `coverage.check`: copago, deducible restante, nombre del pagador.
- Al llegar `episode.written`, refrescar los gráficos automáticamente. **Ese refresco en vivo es el cierre visual del pitch.**

**DoD Fase 3:** Lewis hace una llamada de prueba y tú ves todo aparecer sin tocar nada.

### Fase 4 — T+16h → T+20h · Datos reales y pulido
- `USE_MOCKS=false` en todo. Datos reales de Medplum vía Kiwis.
- Sync #1 y Sync #2 con los tres.
- Pulido visual: es el 45% del tiempo de pantalla del demo.
  - Tipografía y espaciado consistentes. Sin scroll horizontal.
  - Modo oscuro si el proyector lo pide — **prueba en el proyector real si puedes.**
  - Estados vacíos y de carga que no se vean rotos.
- **Prueba a la resolución del proyector**, no a la de tu monitor. 1280×720 es lo más probable.

### Fase 5 — T+20h → demo · Runbook y blindaje
- Escribe `ops/demo-runbook.md`: cada clic del demo, en orden, con el estado esperado.
- Botón de reset probado 5 veces. Después de resetear, el dashboard queda idéntico al inicio.
- **Modo respaldo**: un flag que hace que todo el dashboard lea de fixtures. Si el wifi muere, el demo sigue. Prepáralo en T+22h, no en el escenario.
- Ensayar el guion visual 3 veces con Lewis hablando.

---

## 7. `dashboard/CLAUDE.md` y `coverage/CLAUDE.md`

**`coverage/CLAUDE.md`:**
```markdown
# loop-coverage

Microservicio de elegibilidad (Stedi 270/271) para Loop. Puerto 3003.

## Reglas
- SOLO edito archivos dentro de `coverage/`. Nunca toco `core/` ni `voice/`.
- `../shared/contracts.ts` es de solo lectura.
- Soy el ÚNICO servicio que habla con Stedi. Nadie más ve un 271 crudo.

## Regla crítica
`voiceSummary` lo lee un agente de voz LITERAL, sin pasar por un LLM.
Por eso:
- Debe ser una frase corta, en segunda persona, sin jerga de seguros.
- Los montos van en lenguaje humano ("25 dólares", no "2500 cents").
- Si no tengo un dato con certeza, NO lo invento. Digo que no pude verificarlo.
- Nunca genero este campo con un LLM. Es una plantilla determinista.

## Fallback
Si Stedi falla o tarda >3s: status="unknown", voiceSummary honesto, HTTP 200.
NUNCA devuelvo 500 — hay una llamada de voz en curso que no se puede caer.

## Alcance
Apunto a servicios con respuesta real: visitas de telesalud (CPT 90834),
copagos, deducible, vigencia de receta. NUNCA a suplementos — los seguros
no los cubren y la respuesta no ayuda a nadie.

## Stack
TypeScript + Node + Fastify. zod para validar. Sin base de datos.
```

**`dashboard/CLAUDE.md`:**
```markdown
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
```

---

## 8. Primer prompt para tu Claude Code

Dos sesiones separadas, una por carpeta. Empieza por coverage.

**Sesión 1 — coverage:**
```
Lee plan/03-CARLOS-dashboard-coverage.md completo y shared/contracts.ts.

Estamos en la Fase 1. Construye el servicio loop-coverage en coverage/
con TypeScript + Fastify en el puerto 3003.

Endpoint:
  POST /api/v1/coverage/check   (Contrato 3 del brief, shape exacto)
  GET  /healthz

Requisitos:
- Llamada real a la API de eligibility de Stedi (270), parseo del 271.
- Mapeo a la respuesta del Contrato 3, validado con zod.
- `voiceSummary` generado por PLANTILLA DETERMINISTA, nunca por LLM.
  Frase corta, segunda persona, montos en lenguaje humano.
- USE_MOCKS=true → devuelve shared/fixtures/coverage.covered.json.
- Timeout de 3s a Stedi. Si falla: status="unknown", HTTP 200,
  voiceSummary honesto. NUNCA un 500.
- Guarda el 271 crudo de cada llamada en coverage/fixtures/ para debug.
- CORS abierto a localhost:3002.

No toques carpetas fuera de coverage/.
```

**Sesión 2 — dashboard** (arráncala en T+4h):
```
Lee plan/03-CARLOS-dashboard-coverage.md completo y shared/contracts.ts.

Estamos en la Fase 2. Construye loop-dashboard en dashboard/ con
Next.js App Router + TypeScript + Tailwind + Recharts, puerto 3000.

Consume SOLO los endpoints de loop-core (:3001) del Contrato 4.
Si :3001 no responde, cae a shared/fixtures/. Nunca pantalla en blanco.

Vistas en una sola página:
1. Header del paciente: nombre, edad, condición activa, medicación, clínico.
2. Serie de 30 días de heart rate con banda de baseline (mean ± sd) y
   marcadores verticales en cada episodio. Selector de métrica (HR/HRV/RR).
3. Gráfico de barras de outcomes: duración media de episodio por intervención,
   con una línea de referencia en baselineNoInterventionAvgDurationMinutes.
   Es la visualización más importante de la página.
4. Panel lateral de llamada en vivo — por ahora un placeholder vacío
   con estado "sin llamada activa". El SSE se conecta en la Fase 3.
5. Panel de control de demo: botones "Trigger panic spike",
   "Trigger cardiac red-flag", "Reset demo" → POST a :3001/api/v1/demo/*.

Diseñado para proyectarse a 1280x720. Texto grande, sin scroll horizontal.

No toques carpetas fuera de dashboard/.
```

---

## 9. Checkpoints de integración

| Checkpoint | Cuándo | Qué se prueba | Tu responsabilidad |
|---|---|---|---|
| **Contract freeze** | T0+45min | `shared/contracts.ts` compila para los tres | Confirmar el shape de coverage |
| **Coverage vivo** | T+4h | Lewis puede hacer curl a `:3003` y recibir un copago | Avisarle en cuanto esté |
| **SSE vivo** | T+8h | Recibes eventos del stream de Lewis | Conectarte aunque sean falsos |
| **Sync #1** | T+16h | Llamada real → episodio escrito → tu dashboard se actualiza solo | Refresco automático al `episode.written` |
| **Sync #2** | T+20h | Red-flag pinta el badge, Stedi en vivo pinta la tarjeta | Ambos probados 3 veces |
| **Demo lock** | T+24h | 3 ensayos completos sin tocar código | Runbook escrito, reset limpio |

**Protocolo de cambio de contrato:** mensaje al grupo → PR a `shared/` → los tres hacen pull → confirmación de los tres.

---

## 10. Tu momento en el demo (3 min)

Tienes **80 de los 180 segundos** en pantalla. Más que nadie.

- **0:00–0:10 — La apertura.** El dashboard abre mostrando 30 días de baseline y 3 episodios previos. *"Estos datos ya existen. Solo que no están en ningún lugar útil."* Si esta pantalla se ve amateur, el pitch arranca cuesta arriba.
- **0:10–1:10** — Tu panel lateral muestra el transcript fluyendo y la biometría subiendo mientras Lewis habla.
- **1:10–1:40 — Stedi en vivo.** La tarjeta de cobertura aparece con la respuesta real del pagador. *Un API call en vivo a mitad de un demo es una señal de confianza que los jueces registran.*
- **1:40–2:00** — Badge rojo de escalación con el ID de la regla visible.
- **2:20–3:00 — El cierre.** El episodio nuevo aparece escrito, y el gráfico de outcomes muestra qué intervención correlaciona con episodios más cortos. *"Esta es la parte que nadie más está construyendo."*

**El gráfico de outcomes es la última cosa que los jueces van a ver.** Que sea el componente mejor terminado de todo el proyecto.

---

## 11. Riesgos y plan B

| Riesgo | Plan B |
|---|---|
| El alta de Stedi tarda / sandbox limitado | Por eso el paso 3 de tu hora 0. Con el 271 crudo guardado, tienes un replay fiel. Si en el escenario Stedi no responde, el fallback sirve la respuesta guardada y **el pitch sigue siendo honesto** — se dice "esta es una respuesta capturada del sandbox". |
| El 271 viene con un shape distinto al esperado | Es lo normal con EDI. Por eso capturas la respuesta real en la hora 0, antes de escribir el parser. |
| Kiwis no tiene `/outcomes` a tiempo | Pinta desde `shared/fixtures/outcomes.sample.json`. El componente se construye contra el fixture desde el día uno, así que el swap es una variable de entorno. |
| El SSE de Lewis se cae a mitad del demo | `EventSource` reconecta solo. Además, guarda los últimos eventos en estado — si se corta, la pantalla no se vacía. |
| Wifi del hackathon muere | Modo respaldo global: `NEXT_PUBLIC_USE_FIXTURES=true` y todo el dashboard corre local. Prepáralo en T+22h. |
| El proyector recorta el layout | Prueba a 1280×720 desde el principio. Nada crítico debajo del pliegue. |

---

## 12. Definition of Done — tus dos plataformas

**loop-coverage**
- [ ] Llamada real 270/271 a Stedi funcionando
- [ ] Respuesta mapeada al Contrato 3, validada con zod
- [ ] `voiceSummary` por plantilla determinista, sin LLM, sin jerga
- [ ] Timeout de 3s con fallback a `status: "unknown"` y HTTP 200
- [ ] 271 crudo capturado y guardado como red de seguridad
- [ ] Apuntado a telesalud/copago/deducible, **no** a suplementos

**loop-dashboard**
- [ ] Header de paciente con datos reales de Medplum vía Kiwis
- [ ] Serie de 30 días con banda de baseline y episodios marcados
- [ ] **Gráfico de outcomes por intervención** — el mejor terminado de todos
- [ ] Panel de llamada en vivo por SSE: transcript, biometría, auto-scroll
- [ ] Badge de escalación mostrando el ID de la regla
- [ ] Tarjeta de cobertura con copago y deducible
- [ ] Refresco automático al recibir `episode.written`
- [ ] Panel de control de demo con spike y reset
- [ ] Probado a 1280×720, sin scroll horizontal
- [ ] Modo respaldo con fixtures si muere el wifi
- [ ] `ops/demo-runbook.md` escrito y ensayado 3 veces
