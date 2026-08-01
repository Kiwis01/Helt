# Runbook del demo — bloque de Lewis (loop-voice)

Tres minutos en total. **Lewis conduce del 0:10 al 2:00** (110 de los 180 segundos).
Este documento es el guion minuto a minuto, con el plan B de cada paso.

> Regla del escenario: **si algo falla, no se depura en vivo.** Se pasa al plan B escrito aquí
> y se sigue hablando. Cada plan B está probado y cada uno se ve bien en pantalla.

---

## Pre-vuelo (T-30 min, en la laptop del escenario)

Marcar cada casilla. **La misma laptop que se va a usar**, no otra.

### 1. Micrófono

- [ ] Micrófono de **diadema** conectado (no el de la laptop — el ruido de sala rompe el STT).
- [ ] Seleccionado como entrada por defecto en el sistema operativo.
- [ ] Permiso de micrófono concedido a `http://localhost:3002` en el navegador que se va a usar.
      Chrome recuerda el permiso por origen: si se prueba en otro puerto no cuenta.
- [ ] Probado de verdad: abrir `http://localhost:3002`, hablar, ver el transcript parcial aparecer.

### 2. Servidor arriba

```bash
npm install
npm -w voice start
```

- [ ] El banner dice `puerto 3002`, `mocks SI` (o `NO` si se demuestra en vivo con Kiwis/Carlos).
- [ ] El banner **no** muestra la advertencia de "OTRO PROCESO responde en localhost:3002".
      Si la muestra: `npx kill-port 3002` y reiniciar.
- [ ] `TTS Deepgram Aura-2`. Si dice `AWS Polly (respaldo)` o `NINGUNO`, revisar credenciales
      antes de subir al escenario (el demo se puede hacer mudo, pero se siente muerto).
- [ ] `red-flags 9 reglas deterministas, activas siempre`.

```bash
curl -s http://localhost:3002/healthz
```

- [ ] `{"ok":true,"service":"loop-voice",...}`.

### 3. Contexto precargado

- [ ] En el arranque aparece `[coreClient] contexto precargado para loop-demo-patient-001 ·
      fuente=... · HR 118bpm (baseline 68)`.
- [ ] `fuente=live` si Kiwis está arriba, `fuente=fixture` con mocks. **Las dos sirven**;
      lo que no sirve es no mirarlo, porque `fuente` es lo que decide qué números se dicen.
- [ ] El pre-calentado del TTS terminó: `tts.warm-complete`. Los guiones del 911 y del 988 ya
      están en la caché LRU, así que la escalación suena instantánea.

### 4. Verificación en frío (1 minuto, no se salta)

```bash
npm -w voice run smoke
```

- [ ] `9/9 comprobaciones en verde`.
- [ ] `llamadas totales al LLM durante el smoke: 0` ← esta línea es la que se le enseña a un juez.

### 5. Audio de respaldo grabado

- [ ] Grabación de la llamada completa (60 s, camino feliz) en el escritorio, como
      `plan-b-llamada.mp3`, con el reproductor **ya abierto y pausado en 0:00**.
- [ ] Grabación corta del camino de red-flag (`plan-b-redflag.mp3`), igual.
- [ ] Probado que el volumen de salida se oye en la sala.

### 6. Ventanas preparadas (y en este orden en la barra de tareas)

- [ ] **Ventana 1** — navegador en `http://localhost:3002` (cliente push-to-talk).
- [ ] **Ventana 2** — dashboard de Carlos en `http://localhost:3000`, ya conectado al SSE.
      Confirmar que recibe: `curl -X POST http://localhost:3002/api/v1/live/test-event
      -H 'content-type: application/json' -d '{"type":"transcript.turn"}'` → debe aparecer.
- [ ] **Ventana 3** — terminal con el `curl` de `/api/v1/debug/redflag` **ya tecleado, sin Enter**.
- [ ] **Ventana 4** — terminal con el log del servidor visible (por si hay que señalar
      `redflag.evaluated` o `safety.escalation`).

### 7. Ensayo

- [ ] La llamada de 60 s ensayada **10 veces**. Las frases exactas están abajo, memorizadas.
- [ ] El camino de red-flag ensayado **3 veces** seguidas sin tocar código.

---

## 0:10 – 1:10 · La llamada en vivo (60 s, el bloque más largo)

**Objetivo:** que se oiga a un agente citando números medidos y guiando una intervención
escrita por un clínico. La primera frase tiene que llevar un número concreto.

| t | Qué hago | Qué se ve / se oye | Si falla |
|---|---|---|---|
| 0:10 | Ventana 1. Clic en **Iniciar llamada**. | El agente locuta el disclosure: *"soy un acompañante, no soy un sustituto de atención de emergencia…"*. Estado `greeting`. | El botón no responde → recargar (F5) y volver a darle. Si tampoco: **Plan B-1**. |
| 0:18 | (no hago nada, el saludo sigue solo) | *"Hola Alex, soy Loop, estoy contigo. **Estoy viendo tu ritmo cardiaco en 118, y tu promedio de las últimas semanas es 68.** Tu respiración está en 24 por minuto, tu promedio es 14. Tu plan de cuidado, escrito por Dr. Maya Chen, dice empezar con Box breathing. ¿Lo hacemos juntos?"* | Se oye pero no se lee en el dashboard → seguir hablando, el audio es lo que importa. |
| 0:18 | Señalo la ventana 2 mientras habla. | En el dashboard: `call.started`, los `transcript.turn` cayendo y la gráfica de `biometrics.tick` subiendo cada 3 s. | El dashboard no pinta → **no se para el demo**; se dice "el transcript también está saliendo por el stream" y se sigue. Carlos lo arregla en su bloque. |
| 0:30 | Pulso el botón de hablar y digo: **"Sí, vamos."** | El agente arranca la respiración de caja con **timing real**: *"Inhala por la nariz mientras cuento cuatro: uno, dos, tres, cuatro."* Estado `intervention`. | El STT no me oye (no aparece mi turno) → **escribo `sí, vamos` en el campo de texto del cliente y pulso Enter.** Entra por el mismo pipeline. Nadie nota la diferencia. |
| 0:35 | Respiro con él, en silencio, **dos ciclos completos**. Esto es lo que hace que el demo se sienta humano: no lo aceleres. | Las pausas son de 4 segundos de verdad. La gráfica del dashboard empieza a bajar en cuanto la intervención se completa. | La respiración se hace larga para el tiempo que queda → digo **"para"** y el agente corta en el paso siguiente. |
| 1:00 | Digo: **"Como un seis."** (respuesta al "¿del cero al diez, cuánto bajó?") | El agente: *"Gracias. Y en lo más fuerte, del cero al diez, ¿qué tan intenso llegó a sentirse?"* Queda registrado `patientReportedRelief: 6`. | Si no captó el número, sigue la conversación normal y el campo queda vacío en el episodio. No pasa nada, se sigue. |
| 1:08 | Digo: **"Siete."** | Queda `severitySelfReported: 7` y **esto es lo que encadena con el coverage**. | — |

**Frase de transición hacia Carlos:** *"y aquí es donde el plan dice hablar con su equipo, que
tiene un costo."*

### Plan B-1 — el micrófono o el navegador mueren

1. Ventana 3, cambiar el `curl` por `/api/v1/call/simulate` y mandar los turnos a mano:

```bash
curl -s localhost:3002/api/v1/call/simulate -H 'content-type: application/json' \
     -d '{"text":"si, vamos"}'
```

Todo lo demás (SSE, dashboard, episodio, care plan) sigue funcionando igual.

2. Si además el servidor está caído: reproducir `plan-b-llamada.mp3` y narrar por encima.
   El audio es de una corrida real; se dice que lo es.

---

## 1:10 – 1:40 · El coverage check (lo pinta Carlos)

**Objetivo:** que el precio salga **de la conversación**, no de un botón.

| t | Qué hago | Qué se ve / se oye | Si falla |
|---|---|---|---|
| 1:10 | Nada: el check se dispara solo, justo después de la severidad. Si no salta, pregunto en voz alta: **"¿y cuánto me va a costar eso con mi seguro?"** | Estado `coverage`. El agente: *"Tu plan también dice: Message care team."* y luego, **literal**: *"Tu sesión de telesalud está cubierta. Tu copago es de 25 dólares y ya cubriste casi todo tu deducible."* | El agente contesta *"no pude verificar tu cobertura ahora mismo…"* → **es el comportamiento correcto**, no un fallo. Se dice en voz alta: "cuando la verificación no vuelve, el agente lo dice; nunca inventa un copago". Es un punto a favor, no en contra. |
| 1:15 | Señalo la ventana 2. | En el dashboard: `coverage.check` con `status: covered` y `copayCents: 2500`. | Si el dashboard no lo pinta, sigo: la frase ya se oyó. |
| 1:25 | **La frase del pitch:** *"ese resumen lo escribe el servicio de cobertura a partir de un 271 real, y el agente lo lee palabra por palabra. No pasa por el modelo. Redondear el copago de alguien es un fallo del que no se vuelve."* | — | — |

### Plan B-2 — `:3003` no responde

No hay que hacer nada: el cliente degrada solo a `status: unknown` con un `voiceSummary`
honesto. **Se convierte en argumento**: el agente dice que no pudo verificarlo y remite al
equipo de cuidado. Es exactamente lo que debe hacer un sistema clínico.

---

## 1:40 – 2:00 · El demo de seguridad (20 s — el momento que decide el pitch)

**Objetivo:** que un juez clínico se incline hacia adelante. Veinte segundos, sin adornos.

| t | Qué hago | Qué se ve / se oye | Si falla |
|---|---|---|---|
| 1:40 | Cuelgo la llamada anterior (**Colgar**) y arranco una **segunda llamada**. | En el dashboard: `call.ended` con `outcome: resolved-with-intervention`, y después `episode.written` con el `encounterId`. | Si no sale `episode.written` es que `:3001` no contestó; el episodio quedó en `voice/.episodes-pending/`. No se menciona salvo que pregunten. |
| 1:45 | Digo, con calma: **"Me duele el pecho y se me va al brazo izquierdo."** | **Corte inmediato.** Estado `escalated`, banner rojo. El agente locuta el guion fijo: *"Voy a parar aquí un momento. Lo que me estás describiendo necesita atención médica inmediata. Por favor cuelga y llama al nueve uno uno ahora. No soy un sustituto de atención de emergencia."* La llamada termina sola. | El STT falla → **lo escribo en el campo de texto.** Mismo pipeline, mismo resultado, mismo evento. |
| 1:50 | Señalo la ventana 2. | `safety.escalation` con `rule: "RF-01-CHEST-PAIN-RADIATING"` en pantalla, y luego `call.ended` con `outcome: escalated-emergency`. | — |
| 1:52 | **La frase que cierra:** *"eso no lo decidió el modelo. El modelo no vio ese turno. Es una regla determinista que corre antes, en cada turno, y que ustedes pueden correr en su propia terminal."* | — | — |
| 1:55 | Ventana 3, Enter al `curl` ya tecleado. | El JSON con `ruleId`, `action: "advise-911"`, `matchedEvidence: "dolor toracico: 'duele el pecho' + irradiacion: 'brazo'"`, y `engine.llmInvolved: false`. | Si el servidor no responde: `npm -w voice run redflag "me duele el pecho y se me va al brazo"` — no necesita servidor, ni red, ni credenciales. |

El `curl` que tiene que estar ya tecleado en la ventana 3:

```bash
curl -s http://localhost:3002/api/v1/debug/redflag -H 'content-type: application/json' \
     -d '{"text":"me duele el pecho y se me va al brazo"}'
```

### Plan B-3 — la escalación no dispara en vivo

Nunca ha pasado (90 tests cubren el motor), pero si pasara: **no repetir la frase esperando que
salga**. Se pasa directo a la ventana 3 y se demuestra el motor desde la terminal, que es la
demostración más fuerte de las dos. Se enmarca así: *"lo importante no es que lo detecte en el
audio, es que la decisión sea código auditable, y aquí está."*

### Plan B-4 — todo lo demás ha fallado

`npm -w voice run smoke` en pantalla completa. Nueve comprobaciones en verde, incluida la que
prueba con un contador que el LLM se invocó **cero** veces durante una escalación. Sin
micrófono, sin red y sin dashboard. Es un pitch defendible por sí solo.

---

## Preguntas que van a hacer (y la respuesta corta)

**"¿Cómo sé que no es el prompt el que decide escalar?"**
`voice/src/safety/rules.ts` — nueve reglas, cada una con su ID. `npm run redflag "<frase>"` da
el mismo veredicto que la llamada en vivo porque **es la misma función**. Y el smoke lo prueba
con un contador de invocaciones del modelo.

**"¿Y si la biometría está normal pero la persona está teniendo un infarto?"**
Es la inversión lógica que respetamos explícitamente: biometría normal es motivo para
tranquilizar, **nunca** para descartar una emergencia. Las reglas de texto (RF-01 a RF-07)
disparan sin mirar la biometría. Está escrito en las reglas de postura del prompt y, más
importante, en el código.

**"¿Diagnostica?"**
No, y es una decisión de producto. Hay un post-filtro determinista sobre la salida del modelo
(`src/safety/outputFilter.ts`) que corre **por frase, antes del TTS**: si el modelo escribe
"estás teniendo un ataque de pánico", esa frase se sustituye por una segura y nunca llega al
altavoz.

**"¿El transcript lleva PII a Medplum?"**
No: se redacta antes de persistirlo (`src/redaction/pii.ts`) y `transcript.redacted` es `true`
por construcción — no hay camino de código que lo ponga en `false`.

---

## Después del demo

- [ ] `ls voice/.episodes-pending/` — si hay archivos, son episodios que `:3001` no aceptó.
      Reenviarlos si hace falta.
- [ ] No tocar código hasta que el bloque de los tres haya terminado.
