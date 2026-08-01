# loop-voice

Agente de voz + motor de seguridad para Loop (hackathon YC x Medplum).
Deepgram (camino manual) + AWS Bedrock. **Puerto 3002**, leido de `VOICE_PORT`.

## Reglas

- SOLO edito archivos dentro de `voice/`. Nunca toco `core/`, `dashboard/` ni `coverage/`.
- `../shared/contracts.ts` y `../shared/constants.ts` son de **solo lectura**.
- El `.env` de la raiz tiene secretos reales: **nunca lo leo entero, nunca lo
  imprimo, nunca lo copio, nunca lo edito.** La plantilla vacia es `ops/.env.example`.
- NUNCA hablo FHIR. Consumo el JSON de loop-core (:3001).
- NUNCA llamo a Stedi. Llamo a loop-coverage (:3003) y leo su campo
  `voiceSummary` **LITERAL**, sin pasarlo por el LLM.
- Codigo y comentarios en espanol neutro. Identificadores en ingles (camelCase).
- TypeScript estricto. Nada de `any` salvo en fronteras de SDK externas, justificado.

## Regla de seguridad — la mas importante del repo

El motor de red-flags es **DETERMINISTA** y corre **ANTES** de cualquier llamada
al LLM. No es una instruccion de prompt. Es codigo.

Si `evaluate()` devuelve `triggered=true`:

- el LLM **NO** se invoca para ese turno
- se reproduce un guion de escalacion **HARDCODEADO** (911 y 988 separados)
- la llamada termina
- se registra el ID de la regla que disparo y la evidencia que la disparo

Nunca muevo esta logica a un prompt. Nunca dejo que el LLM decida si escalar.

**La inversion logica:** biometria normal es motivo para tranquilizar y
desescalar, **nunca** para *descartar* una emergencia. El sistema jamas infiere
"historia sana + ansiedad diagnosticada -> esto es ansiedad".

## Postura del agente

- Contextualiza, nunca diagnostica. Nunca digo "estas teniendo un ataque de panico".
- Digo que esta haciendo el cuerpo y que dice el care plan que escribio su clinico.
- La primera respuesta de cada llamada cita un numero concreto del baseline
  ("tu ritmo esta en 118, tu promedio es 68"). Eso prueba que hay datos reales atras.
- Disclosure al inicio de cada llamada: "no soy un sustituto de atencion de emergencia".
- Cero recomendaciones de medicamentos o suplementos. Cero ordenes autonomas.
- Post-filtro determinista sobre la salida del LLM (`filterAgentOutput`): lista de
  frases prohibidas. Si matchea, se reemplaza por una frase segura.

## Stack y decisiones de arquitectura (YA TOMADAS, no se re-litigan)

- Node 24 + TypeScript estricto + ESM (`"type": "module"`).
- Fastify + `@fastify/websocket` + `@fastify/cors` + `@fastify/static`. zod, vitest, tsx.
- **Idioma del demo: espanol.** El motor de red-flags matchea ES **e** EN.
- **Puerto 3002 via `VOICE_PORT`.** Se IGNORA la variable generica `PORT`: el
  `.env` compartido la tiene en 8787 para otro proceso y usarla romperia a Carlos.
- **NO se usa la Voice Agent API de Deepgram.** Camino manual:
  - **STT**: Deepgram Listen WebSocket, modelo `nova-3`, `language=multi`,
    corriendo en el **SERVIDOR**. El browser manda PCM crudo por WS a :3002 y el
    servidor lo reenvia a Deepgram. Dos motivos, ambos de seguridad: el motor de
    red-flags DEBE ver el transcript en el servidor, y la API key no sale al browser.
  - **TTS**: Deepgram Aura-2, voz `DG_TTS_VOICE` (default `aura-2-selena-es`),
    con **fallback automatico a AWS Polly** (`POLLY_VOICE`=Lupe,
    `POLLY_ENGINE`=generative) si Deepgram falla o tarda mas de `TIMEOUT_TTS_MS`.
- **LLM: AWS Bedrock Converse (streaming)** con `@aws-sdk/client-bedrock-runtime`
  y `ConverseStreamCommand`. El modelo se lee **siempre** de
  `process.env.AGENT_MODEL_ID`, nunca hardcodeado. El brief menciona
  `ANTHROPIC_API_KEY` pero esa variable no tiene valor en el `.env` real: Bedrock
  es el camino primario. La capa LLM vive detras de la interfaz `LlmProvider`.
- **`USE_MOCKS=true` por defecto.** Con mocks, los clientes HTTP leen de
  `shared/fixtures/` en vez de llamar a :3001 / :3003.

## Estructura

```
voice/
  src/
    config.ts        carga del .env de la raiz, nunca imprime credenciales
    types.ts         re-export de shared/contracts.ts + tipos internos
    safety/          motor de red-flags (determinista, puro) + post-filtro
    clients/         coreClient (:3001), coverageClient (:3003) — nunca lanzan
    live/            bus de eventos + SSE hacia el dashboard de Carlos
    agent/           LlmProvider (Bedrock) + construccion del system prompt
    audio/           stt.ts (relay a Deepgram Listen), tts.ts (Aura-2 / Polly)
    session/         CallSession: turnos, intervenciones, coverage, episodio
    redaction/       redaccion de PII antes de persistir el transcript
    orchestrator/    el loop del turno: STT -> red-flags -> LLM -> TTS
    routes/          HTTP + WS + SSE
    cli/redflag.ts   `npm run redflag "<frase>"`
    server.ts
  public/            cliente de microfono del navegador
  scripts/           smoke test
```

## Comandos

```bash
npm run dev                                  # tsx watch, :3002
npm test                                     # vitest run (suite de red-flags)
npm run redflag "me duele el pecho y se va al brazo"
npm run build                                # tsc --noEmit
```

> Nota para `src/cli/redflag.ts`: npm pierde las comillas al reenviar el
> argumento, asi que la frase llega troceada en varios `argv`. El CLI debe hacer
> `process.argv.slice(2).join(' ')`, no `process.argv[2]`.

## Prioridades

1. Motor de red-flags con las 9 reglas y ~30 tests verdes. Es lo que los jueces
   van a interrogar. Se construye **antes** que la voz.
2. La llamada **nunca se cae** aunque :3001 y :3003 esten caidos: timeouts,
   fallbacks y ultimo contexto conocido.
3. Latencia <800ms de fin-de-habla a inicio-de-respuesta: contexto precargado al
   inicio de la llamada (no por turno), TTS por frases (no esperar al LLM completo),
   frase puente mientras llega la respuesta.
