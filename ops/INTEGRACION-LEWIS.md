# Integración — loop-voice (Lewis, `:3002`)

Mensaje para el grupo. Todo lo que hay aquí está **copiado de una corrida real**
(`npm -w voice start` con `USE_MOCKS=true`), no escrito a mano.

**Arrancar mi servicio, en dos comandos:** `npm install` → `npm -w voice start`.
No necesita que `:3001` ni `:3003` existan.

---

## 📡 Para CARLOS — el stream SSE ya está vivo

### La URL

```
GET http://localhost:3002/api/v1/live/stream        (text/event-stream)
```

CORS abierto a cualquier `localhost`, así que un `new EventSource(...)` desde `:3000` funciona
sin más. Tres cosas que te ahorran trabajo:

- **Replay al conectar.** Los últimos 200 eventos se reenvían en cuanto abres la conexión. Si
  tu dashboard conecta a mitad del demo, se hidrata solo; no ves una pantalla vacía.
- **Heartbeat cada 15 s** (`: ping`), para que ningún proxy te cierre el stream ocioso.
- **Plan B sin `EventSource`:** `GET /api/v1/live/events?limit=50` devuelve exactamente lo
  mismo en JSON plano. Si el stream te da problemas en el escenario, haz polling cada segundo
  y el demo se ve igual.

### 👉 Conéctate HOY, sin esperar al loop de voz

```bash
curl -X POST http://localhost:3002/api/v1/live/test-event \
     -H 'content-type: application/json' \
     -d '{"type":"safety.escalation"}'
```

Inyecta un evento **real** en el bus y sale por tu stream al instante. `type` es opcional
(default `transcript.turn`) y `data` también: si no lo mandas, genero un payload de ejemplo
coherente con los números del demo. Si lo mandas, se emite tal cual — sirve para probar cómo
reacciona tu dashboard a un payload incompleto.

Responde `202` con el evento tal como quedó en el bus (con su `at` ya sellado), para que puedas
comparar contra lo que te llegó por el stream:

```json
{ "ok": true, "emitted": { "type": "safety.escalation", "data": { ... } } }
```

Un `type` que no sea uno de los 7 devuelve `400` con la lista de válidos. **No depende de
Deepgram, ni de Bedrock, ni de `:3001`, ni de `:3003`.**

### Los 7 tipos, con un ejemplo REAL de cada uno

Copiados literalmente del stream de una llamada completa (`call-c941`) más una llamada con
red-flag (`call-c942`). Todos los `data` llevan **siempre** `callId` y `at` (ISO-8601 UTC).

```
event: call.started
data: {"callId":"call-c941","patientId":"loop-demo-patient-001","at":"2026-08-01T20:17:50.497Z"}

event: transcript.turn
data: {"callId":"call-c941","speaker":"patient","text":"si, vamos, hagamos la respiracion","at":"2026-08-01T20:17:53.906Z"}

event: transcript.turn
data: {"callId":"call-c941","speaker":"agent","text":"Hola Alex, soy Loop, estoy contigo. Estoy viendo tu ritmo cardiaco en 118, y tu promedio de las últimas semanas es 68. Tu respiración está en 24 por minuto, tu promedio es 14. Tu plan de cuidado, escrito por Dr. Maya Chen, dice empezar con Box breathing. ¿Lo hacemos juntos?","at":"2026-08-01T20:17:50.498Z"}

event: biometrics.tick
data: {"callId":"call-c941","heartRate":120,"hrv":21,"respiratoryRate":25,"at":"2026-08-01T20:17:53.498Z"}

event: coverage.check
data: {"callId":"call-c941","checkId":"cov-1a2b","status":"covered","copayCents":2500,"at":"2026-08-01T20:17:54.263Z"}

event: call.ended
data: {"callId":"call-c941","outcome":"resolved-with-intervention","durationSeconds":4,"at":"2026-08-01T20:17:54.268Z"}

event: episode.written
data: {"callId":"call-c941","encounterId":"enc-mock-call-c941","at":"2026-08-01T20:17:54.269Z"}

event: safety.escalation
data: {"callId":"call-c942","rule":"RF-01-CHEST-PAIN-RADIATING","action":"advise-911","at":"2026-08-01T20:17:54.270Z"}
```

### ⚠️ Tres detalles que te van a morder si no los lees

**1. `action` es `advise-911`, NO `advised-911`.**
El ejemplo del brief (sección 4, Contrato 5) escribe `"action":"advised-911"`, en pasado. Ese
participio no existe en ningún sitio del código: el tipo `EscalationAction` de
`shared/contracts.ts` —que importamos los tres— dice `'advise-911' | 'advise-988' |
'connect-human'`, y es el mismo valor que va al episodio que recibe Kiwis. Emito el del
contrato, no el de la prosa del brief.

> **Si tu dashboard hace `if (data.action === 'advised-911')`, no va a pintar nada.**
> Recomendación: no matchees el string. Pinta el banner rojo con la sola presencia de un evento
> `safety.escalation` y muestra `data.rule` como texto — el ID de la regla es lo que quiere leer
> el juez en pantalla, no el verbo.

**2. `transcript.turn` son turnos CERRADOS, no deltas.**
Cada evento trae el texto completo de un turno. No tienes que acumular nada ni deduplicar. Los
parciales del STT y el streaming del modelo se quedan en el WebSocket del navegador; al bus
solo llega lo definitivo.

**3. `episode.written` puede no llegar nunca.**
Solo se emite si `:3001` confirma el `Encounter`. Si Kiwis está caído, la llamada termina
igual (verás `call.ended`), el episodio se guarda en `voice/.episodes-pending/` y ese evento no
sale. **No bloquees tu vista esperándolo.**

### Notas menores

- `biometrics.tick` sale cada **3 s** mientras la llamada está viva. La curva es determinista
  (ni un `Math.random`): sube hacia el pico y baja hacia el baseline en cuanto se completa una
  intervención. Dos ensayos con las mismas acciones dan la misma gráfica.
- `copayCents` en `coverage.check` puede ser `null` (cuando el status es `unknown`).
- `outcome` en `call.ended` ∈ `resolved-with-intervention` | `self-resolved` |
  `escalated-emergency` | `escalated-human` | `abandoned`.
- `biometrics.tick` y `call.ended` no tienen ejemplo en el brief; los shapes de arriba son la
  referencia. Si necesitas otro campo, dímelo y lo añado — es una línea.

### Lo que necesito de ti

| Qué | Para cuándo |
|---|---|
| Confirmar que tu `EventSource` recibe el `test-event` de arriba | **hoy** (es el checkpoint "SSE vivo" de T+8h) |
| Confirmar que no matcheas `advised-911` en ningún sitio | hoy |
| `:3003` respondiendo el Contrato 3 con `voiceSummary` **en español y listo para locutar** | T+16h |
| Que el `voiceSummary` sea **una o dos frases**, sin markdown, sin viñetas, con las cifras en palabras si puede ser (*"veinticinco dólares"* suena mejor que *"$25.00"*) | T+16h |

Mientras tanto leo `shared/fixtures/coverage.covered.json`, así que no me bloqueas.

---

## 🏥 Para KIWIS — el JSON exacto que te voy a mandar

### `POST http://localhost:3001/api/v1/episodes`

Pegado de una corrida real (camino feliz: intervención completada + coverage check).
**Diffeado campo por campo contra `shared/fixtures/episode.sample.json`: mismas claves, mismos
tipos, mismos enums, cero campos de más y cero de menos.**

```json
{
  "patientId": "loop-demo-patient-001",
  "callId": "call-c941",
  "startedAt": "2026-08-01T20:17:50Z",
  "endedAt": "2026-08-01T20:17:54Z",
  "outcome": "resolved-with-intervention",
  "escalation": {
    "triggered": false,
    "rule": null,
    "triggeredAt": null,
    "action": null
  },
  "severitySelfReported": 7,
  "interventionsAttempted": [
    {
      "carePlanActivityId": "cp-act-1",
      "startedAt": "2026-08-01T20:17:53Z",
      "completed": true,
      "patientReportedRelief": 6
    }
  ],
  "biometricsSnapshot": {
    "peakHeartRate": 126,
    "minHrv": 18,
    "peakRespiratoryRate": 27
  },
  "transcript": {
    "redacted": true,
    "turns": [
      { "speaker": "agent", "at": "2026-08-01T20:17:50Z", "text": "Antes de empezar, algo que necesito decirte: soy un acompañante, no soy un sustituto de atención de emergencia. ..." },
      { "speaker": "agent", "at": "2026-08-01T20:17:50Z", "text": "Hola Alex, soy Loop, estoy contigo. Estoy viendo tu ritmo cardiaco en 118, y tu promedio de las últimas semanas es 68. ..." },
      { "speaker": "patient", "at": "2026-08-01T20:17:53Z", "text": "si, vamos, hagamos la respiracion" },
      { "speaker": "agent", "at": "2026-08-01T20:17:53Z", "text": "Inhala por la nariz mientras cuento cuatro: uno, dos, tres, cuatro." },
      { "speaker": "patient", "at": "2026-08-01T20:17:54Z", "text": "como un seis" },
      { "speaker": "patient", "at": "2026-08-01T20:17:54Z", "text": "siete" },
      { "speaker": "agent", "at": "2026-08-01T20:17:54Z", "text": "Tu sesión de telesalud está cubierta. Tu copago es de 25 dólares y ya cubriste casi todo tu deducible." }
    ]
  },
  "coverageChecks": [
    {
      "checkId": "cov-1a2b",
      "serviceType": "telehealth-mental-health",
      "result": "covered",
      "copayCents": 2500
    }
  ]
}
```

Y el mismo payload cuando dispara una red-flag (lo que cambia son estos cuatro campos):

```json
{
  "outcome": "escalated-emergency",
  "escalation": {
    "triggered": true,
    "rule": "RF-01-CHEST-PAIN-RADIATING",
    "triggeredAt": "2026-08-01T20:17:54Z",
    "action": "advise-911"
  },
  "severitySelfReported": null,
  "interventionsAttempted": []
}
```

### Garantías que te doy sobre este payload

- **`transcript.redacted` es siempre `true`.** No hay camino de código que lo ponga en `false`:
  el `true` está escrito literal en el builder y los turnos pasan por el redactor de PII antes
  de salir del proceso.
- **`escalation` lleva siempre sus 4 campos.** Nunca omito ninguno; van a `null` cuando no
  aplica.
- **Todas las fechas son ISO-8601 UTC terminadas en `Z`, con precisión de segundos** (mismo
  formato que tu fixture, sin milisegundos).
- **Se valida contra `episodeWritebackSchema` antes de mandártelo.** Si no valida, te lo mando
  igual y lo grito en mi log: perder el episodio es peor que mandarte uno imperfecto, y un 400
  tuyo es información útil.
- **Sin reintentos.** `POST /episodes` no es idempotente y prefiero no duplicarte un
  `Encounter`. Si fallas, guardo el payload en `voice/.episodes-pending/<callId>.json` y te lo
  reenvío a mano.
- `severitySelfReported` y `patientReportedRelief` son enteros 0–10, o `null` si el paciente no
  dio un número. **No los invento.**

**Tu respuesta**, que espero como `201`:

```json
{ "encounterId": "enc-0042", "medplumUrl": "https://app.medplum.com/Encounter/..." }
```

`medplumUrl` la acepto ausente: si me das el `encounterId`, el episodio ya se escribió y no voy
a tirar eso por una URL que falta.

### ⚠️ `shared/contracts.ts` lo escribí yo, provisionalmente — hay que reconciliarlo

Según el reparto, ese archivo lo publicas **tú en T0**. A la hora de arrancar loop-voice no
existía y sin él no compilaba nada, así que escribí una **transcripción literal de la sección 4
del brief** (que es idéntica en los tres). Está avisado en la cabecera del propio archivo.

**Protocolo cuando publiques el tuyo:**

1. `git diff` entre los dos.
2. **Gana el tuyo.** Eres el owner del contrato.
3. Yo compruebo que `voice/src/types.ts` sigue compilando (`npm -w voice run build`) y aviso en
   el grupo.

Dos cosas que hice a propósito y que quiero que mires antes de reemplazarlo:

- **Los esquemas zod son más permisivos que los tipos** en las uniones de string abiertas
  (`trend`, `carePlanActivity.type`, `clinicalStatus`). Si me mandas un `trend: "steady"` no
  quiero que se caiga una llamada de alguien en pánico por eso.
- **`patientContextSchema` exige todos los campos del ejemplo del brief**, y eso me daba un
  modo de fallo silencioso muy feo: si tu contexto viene sin `medications`, sin
  `baseline.sleepHours` o sin `deltas.hrv` —campos que ni uso para conversar— el `safeParse`
  fallaba, **yo descartaba tu payload live entero y usaba el fixture**. Resultado en el
  escenario: mi agente diciendo "tu ritmo está en 118" (fixture) mientras el dashboard de
  Carlos pinta tu lectura real. Dos números distintos para el mismo paciente.
  Lo arreglé **en mi lado** (`voice/src/clients/contextCoercion.ts`), sin tocar `shared/`:
  normalizo tu contexto antes de validarlo, relleno lo ausente, **derivo** los `deltas` de
  `current` y `baseline` cuando no vienen, y marco lo que falta con centinelas que mi prompt
  sabe callar. Lo único que no relleno es la frecuencia cardiaca: sin ella el contexto es
  inservible y degrado de verdad.

### Lo que necesito de ti

| Qué | Para cuándo |
|---|---|
| `shared/contracts.ts` oficial, para hacer el diff y reconciliar | **cuanto antes** |
| `GET :3001/api/v1/context/:patientId?window=30m` respondiendo el Contrato 1 | T+16h |
| Que el contexto traiga **`safetyEnvelope`** (si falta uso el mío por defecto, pero prefiero el tuyo) | T+16h |
| Que `carePlan.activities[]` traiga **`voiceScript` en español** en la actividad de respiración — es lo que locuto con timing real y lo que hace que el demo se sienta humano | T+16h |
| Que al menos una actividad traiga **`costItem`** (es lo que dispara el coverage check de Carlos desde mi conversación) | T+16h |
| `POST :3001/api/v1/episodes` devolviendo `201` con `encounterId` | T+16h |
| Confirmar que el shape del episodio de arriba te sirve tal cual | hoy |

Mientras tanto leo `shared/fixtures/context.happy.json`, así que **no me bloqueas**.

---

## Resumen de dependencias

| De quién | Qué | Cuándo | ¿Me bloquea ahora? |
|---|---|---|---|
| Kiwis | `shared/contracts.ts` oficial | cuanto antes | No (tengo el provisional) |
| Kiwis | `GET /context` + `POST /episodes` reales | T+16h | No (`USE_MOCKS=true`) |
| Carlos | `POST /coverage/check` real | T+16h | No (`USE_MOCKS=true`) |
| Carlos | confirmar que recibe mi SSE | **hoy** | No, pero es su checkpoint de T+8h |

Para pasar a integración real: `USE_MOCKS=false` en el `.env` de la raíz y reiniciar. Nada más.
Si alguno de los dos servicios se cae con `USE_MOCKS=false`, **la llamada no se cae**: degrado
al último contexto conocido / al fixture, y en cobertura digo la verdad en vez de inventar una
cifra.
