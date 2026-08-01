/**
 * Smoke de punta a punta de loop-voice.
 *
 *   npm -w voice run smoke
 *
 * Levanta el servidor real en un puerto efimero, lo interroga por HTTP y por
 * WebSocket como lo haria el dashboard o el navegador, imprime PASS/FAIL por
 * comprobacion y sale con codigo != 0 si algo falla. Es lo que se corre antes
 * de subir al escenario.
 *
 * =============================================================================
 *  LA COMPROBACION QUE JUSTIFICA ESTE ARCHIVO
 * =============================================================================
 * La numero 6: se inyecta un `LlmProvider` espia con un contador y se manda una
 * frase de red-flag por `POST /api/v1/call/simulate`. Al terminar, el contador
 * tiene que valer CERO. No es una promesa del prompt ni una nota en el README:
 * es una asercion sobre el proceso entero, con las rutas montadas, el
 * orquestador vivo y el episodio escribiendose.
 *
 * El smoke fuerza `USE_MOCKS=true` (se pone ANTES de cargar `config`, y dotenv
 * no sobreescribe lo que ya esta en el entorno) para que el resultado no dependa
 * de si :3001 y :3003 estan levantados. Con `SMOKE_LIVE=1` se respeta lo que
 * diga el `.env` y se prueba contra los servicios de verdad.
 */

import { setTimeout as delay } from 'node:timers/promises';

// -----------------------------------------------------------------------------
// Entorno — se fija ANTES de cargar cualquier modulo que lea `config`
// -----------------------------------------------------------------------------

const live = process.env.SMOKE_LIVE === '1';
if (!live) process.env.USE_MOCKS = 'true';
process.env.LOG_LEVEL = process.env.SMOKE_VERBOSE === '1' ? 'debug' : 'warn';

// Import dinamico a proposito: los estaticos se izan y se evaluarian antes de
// las dos lineas de arriba.
const { buildServer } = await import('../src/server.js');
const { overridePipelineDeps, resetPipelineDeps } = await import(
  '../src/orchestrator/turnPipeline.js'
);
const { liveBus, resetLiveBus } = await import('../src/live/bus.js');
const { sessionStore } = await import('../src/session/sessionStore.js');
const { episodeWritebackSchema } = await import('../src/types.js');
const { default: WebSocket } = await import('ws');

// -----------------------------------------------------------------------------
// Espia del LLM
// -----------------------------------------------------------------------------

const spy = { llmCalls: 0 };

overridePipelineDeps({
  llm: {
    name: 'smoke-spy',
    // eslint-disable-next-line require-yield
    async *streamReply(): AsyncIterable<string> {
      spy.llmCalls += 1;
      yield 'Estoy contigo, te escucho.';
    },
  },
  // TTS falso: el smoke no gasta cuota de Deepgram ni depende de la red.
  synthesize: (text: string) =>
    Promise.resolve({
      audio: Buffer.from(text, 'utf8'),
      contentType: 'audio/mpeg',
      provider: 'deepgram' as const,
      latencyMs: 0,
    }),
  speedFactor: 200,
  bridgeMs: 5_000,
});

// -----------------------------------------------------------------------------
// Andamio de comprobaciones
// -----------------------------------------------------------------------------

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

const results: CheckResult[] = [];

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, ms: Date.now() - startedAt });
  } catch (err) {
    results.push({ name, ok: false, detail: describe(err), ms: Date.now() - startedAt });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// -----------------------------------------------------------------------------
// Arranque
// -----------------------------------------------------------------------------

const app = await buildServer({ warmTts: false });
// Puerto 0 = efimero. El smoke no compite con un :3002 ya levantado.
await app.listen({ port: 0, host: '127.0.0.1' });

const address = app.server.address();
assert(address !== null && typeof address === 'object', 'no se pudo leer el puerto del servidor');
const port = address.port;
const base = `http://127.0.0.1:${port}`;

console.log(`\n  loop-voice smoke · ${base} · mocks=${!live}\n`);

async function postJson(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** Acceso tolerante: el smoke afirma sobre la forma, no la asume. */
function pick(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// =============================================================================
// 1. /healthz
// =============================================================================

await check('1. GET /healthz responde ok', async () => {
  const res = await fetch(`${base}/healthz`);
  assert(res.status === 200, `esperaba 200, llego ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  assert(body['ok'] === true, 'ok !== true');
  assert(body['service'] === 'loop-voice', `service = ${String(body['service'])}`);
  assert(typeof body['port'] === 'number', 'falta port');
  assert(typeof body['useMocks'] === 'boolean', 'falta useMocks');
  assert(typeof body['contextSource'] === 'string', 'falta contextSource');
  assert(typeof body['llmProvider'] === 'string', 'falta llmProvider');
  assert(typeof body['activeCalls'] === 'number', 'falta activeCalls');
  return `contextSource=${String(body['contextSource'])} llm=${String(body['llmProvider'])} deepgram=${String(body['deepgram'])} polly=${String(body['polly'])}`;
});

// =============================================================================
// 2. SSE en vivo
// =============================================================================

await check('2. /api/v1/live/stream entrega un evento tras test-event', async () => {
  const controller = new AbortController();
  try {
    const res = await fetch(`${base}/api/v1/live/stream`, { signal: controller.signal });
    assert(res.status === 200, `esperaba 200, llego ${res.status}`);
    assert(
      (res.headers.get('content-type') ?? '').includes('text/event-stream'),
      `content-type inesperado: ${res.headers.get('content-type') ?? 'ninguno'}`,
    );
    assert(res.body !== null, 'el stream no trae cuerpo');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Primer chunk: el comentario de apertura (`: connected`) y el replay.
    const first = await reader.read();
    buffer += decoder.decode(first.value ?? new Uint8Array(), { stream: true });

    const injected = await postJson('/api/v1/live/test-event', {
      type: 'safety.escalation',
      data: { callId: 'smoke', rule: 'RF-SMOKE', action: 'advise-911' },
    });
    assert(injected.status === 202, `test-event devolvio ${injected.status}`);

    const deadline = Date.now() + 3000;
    while (!buffer.includes('RF-SMOKE') && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), delay(500, { done: true, value: undefined })]);
      if (chunk.value !== undefined) buffer += decoder.decode(chunk.value, { stream: true });
    }

    assert(buffer.includes('event: safety.escalation'), 'no llego el evento por el stream');
    assert(buffer.includes('RF-SMOKE'), 'el payload no llego intacto');
    return 'el dashboard de Carlos recibiria este evento';
  } finally {
    controller.abort();
  }
});

// =============================================================================
// 3-5. El motor de red-flags por HTTP
// =============================================================================

await check('3. debug/redflag: dolor toracico irradiado → RF-01 / 911', async () => {
  const { status, json } = await postJson('/api/v1/debug/redflag', {
    text: 'me duele el pecho y se me corre al brazo izquierdo',
  });
  assert(status === 200, `esperaba 200, llego ${status}`);
  assert(pick(json, 'result', 'triggered') === true, 'no disparo');
  assert(
    pick(json, 'result', 'ruleId') === 'RF-01-CHEST-PAIN-RADIATING',
    `regla inesperada: ${String(pick(json, 'result', 'ruleId'))}`,
  );
  assert(pick(json, 'result', 'action') === 'advise-911', 'accion inesperada');
  const script = pick(json, 'result', 'script');
  assert(typeof script === 'string' && script.includes('nueve uno uno'), 'el guion no es el fijo');
  return `evidencia: ${String(pick(json, 'result', 'matchedEvidence'))}`;
});

await check('4. debug/redflag: HR 163 fuera del envelope → RF-08 (o RF-09)', async () => {
  const { status, json } = await postJson('/api/v1/debug/redflag', {
    text: 'estoy nervioso',
    hr: 163,
  });
  assert(status === 200, `esperaba 200, llego ${status}`);
  assert(pick(json, 'result', 'triggered') === true, 'no disparo con HR 163');
  const rule = String(pick(json, 'result', 'ruleId'));
  assert(
    rule === 'RF-08-BIOMETRIC-ENVELOPE' || rule === 'RF-09-COMBINED',
    `esperaba RF-08 o RF-09, llego ${rule}`,
  );
  assert(pick(json, 'result', 'action') === 'advise-911', 'accion inesperada');
  return `${rule} · ${String(pick(json, 'result', 'matchedEvidence'))}`;
});

await check('5. debug/redflag: ansiedad cotidiana NO dispara', async () => {
  const { status, json } = await postJson('/api/v1/debug/redflag', {
    text: 'estoy un poco nervioso por el trabajo',
  });
  assert(status === 200, `esperaba 200, llego ${status}`);
  assert(
    pick(json, 'result', 'triggered') === false,
    `falso positivo: ${String(pick(json, 'result', 'ruleId'))}`,
  );
  assert(pick(json, 'result', 'severity') === 'none', 'severidad inesperada');
  return 'sin escalacion, la conversacion sigue (que es el producto)';
});

// =============================================================================
// 6. LA COMPROBACION: escalacion real SIN tocar el LLM
// =============================================================================

let escalatedCallId: string | null = null;

await check('6. simulate con red-flag: escala y el LLM NO se invoca', async () => {
  resetLiveBus();
  const before = spy.llmCalls;

  const seen: string[] = [];
  const unsubscribe = liveBus.subscribe((event) => seen.push(event.type));

  const { status, json } = await postJson('/api/v1/call/simulate', {
    text: 'me duele mucho el pecho y se me va al brazo izquierdo',
  });
  unsubscribe();

  assert(status === 200, `esperaba 200, llego ${status}`);
  assert(pick(json, 'result', 'escalated') === true, 'el turno no escalo');
  assert(
    pick(json, 'result', 'ruleId') === 'RF-01-CHEST-PAIN-RADIATING',
    `regla inesperada: ${String(pick(json, 'result', 'ruleId'))}`,
  );
  assert(pick(json, 'result', 'llmInvoked') === false, 'el pipeline dice que invoco al LLM');

  // El contador del espia: la afirmacion que no admite interpretacion.
  assert(
    spy.llmCalls === before,
    `el LLM se invoco ${spy.llmCalls - before} vez/veces durante una escalacion`,
  );

  assert(seen.includes('safety.escalation'), 'no se emitio safety.escalation al bus');
  assert(seen.includes('call.ended'), 'la llamada no se cerro');

  escalatedCallId = String(pick(json, 'callId'));
  return `${escalatedCallId} · llamadas al LLM: ${spy.llmCalls - before} · eventos: ${seen.join(', ')}`;
});

// =============================================================================
// 7. El episodio valida contra el Contrato 2
// =============================================================================

await check('7. el episodio construido valida contra episodeWritebackSchema', async () => {
  assert(escalatedCallId !== null, 'la comprobacion 6 no dejo callId');
  const session = sessionStore.get(escalatedCallId);
  assert(session !== null, `la sesion ${escalatedCallId} no esta en el store`);

  const episode = session.buildEpisode(session.inferOutcome());
  const parsed = episodeWritebackSchema.safeParse(episode);
  assert(
    parsed.success,
    `zod: ${parsed.success ? '' : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ')}`,
  );

  assert(episode.outcome === 'escalated-emergency', `outcome = ${episode.outcome}`);
  assert(episode.escalation.triggered === true, 'el episodio no registra la escalacion');
  assert(
    episode.escalation.rule === 'RF-01-CHEST-PAIN-RADIATING',
    `el episodio no guarda la regla: ${String(episode.escalation.rule)}`,
  );
  assert(episode.transcript.redacted === true, 'el transcript no va marcado como redactado');
  assert(episode.transcript.turns.length >= 2, 'faltan turnos en el transcript');

  return `outcome=${episode.outcome} regla=${String(episode.escalation.rule)} turnos=${episode.transcript.turns.length}`;
});

// =============================================================================
// 8. El cliente del navegador se sirve
// =============================================================================

await check('8. GET / sirve el cliente push-to-talk', async () => {
  const res = await fetch(`${base}/`);
  assert(res.status === 200, `esperaba 200, llego ${res.status}`);
  const html = await res.text();
  assert(html.includes('<'), 'la respuesta no parece HTML');
  const appJs = await fetch(`${base}/app.js`);
  assert(appJs.status === 200, `app.js devolvio ${appJs.status}`);
  return `index.html (${html.length} bytes) + app.js`;
});

// =============================================================================
// 9. El WebSocket de la llamada acepta conexion
// =============================================================================

await check('9. WS /api/v1/call/stream acepta conexion y responde ping', async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/call/stream`);

  const pong = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('el WS no respondio en 3s')), 3000);
    socket.on('open', () => {
      // Primero un `type` desconocido: el protocolo obliga a ignorarlo sin
      // cerrar el socket. Si el servidor cerrara aqui, el ping nunca volveria.
      socket.send(JSON.stringify({ type: 'algo-que-no-existe' }));
      socket.send(JSON.stringify({ type: 'ping', at: 1 }));
    });
    socket.on('message', (data) => {
      const message = String(data);
      if (message.includes('"pong"')) {
        clearTimeout(timer);
        resolve(message);
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  socket.close();
  return `pong recibido, un type desconocido no cerro el socket · ${pong}`;
});

// =============================================================================
// Informe
// =============================================================================

await app.close();
resetPipelineDeps();

const failed = results.filter((r) => !r.ok);

console.log('');
for (const item of results) {
  const badge = item.ok ? 'PASS' : 'FAIL';
  console.log(`  ${badge}  ${item.name}  (${item.ms}ms)`);
  if (item.detail !== '') console.log(`        ${item.detail}`);
}

console.log('');
console.log(`  ${results.length - failed.length}/${results.length} comprobaciones en verde`);
console.log(`  llamadas totales al LLM durante el smoke: ${spy.llmCalls}`);
console.log('');

if (failed.length > 0) {
  console.error(`  ${failed.length} FALLO(S): ${failed.map((f) => f.name).join(', ')}\n`);
  process.exit(1);
}

process.exit(0);
