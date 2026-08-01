'use client';

/**
 * Panel de llamada en vivo — lo que se ve entre 0:10 y 2:00 del demo.
 *
 * Consume el estado que `LiveCallProvider` alimenta desde el SSE de loop-voice
 * (Contrato 5) o desde el guion de replay. Aquí no hay lógica de red ni de
 * seguridad: este componente solo PINTA. En concreto, no calcula ninguna
 * red-flag — la barrera de escalación se dibuja únicamente cuando llega el
 * evento `safety.escalation`, porque quien decide es una regla determinista de
 * loop-voice y el dashboard no puede dar la impresión de opinar sobre eso.
 *
 * EL HÉROE DEL PANEL CAMBIA, y ese es el diseño entero:
 *
 * - En una llamada normal el dato grande es la FRECUENCIA CARDIACA con su
 *   distancia al baseline personal. Es lo único que se mueve solo en pantalla,
 *   así que es lo que hace que el panel se sienta en directo.
 * - En cuanto dispara una regla, `.hero` se muda al ID DE LA REGLA. Los jueces
 *   necesitan leer `RF-01-CHEST-PAIN-RADIATING` desde el fondo de la sala: es
 *   la prueba de que escaló un umbral determinista y no un modelo. La biometría
 *   se encoge a una fila de dato terciario para no competir; dos héroes a la
 *   vez son cero héroes.
 *
 * Sin llamada, el panel enseña una línea y dos botones. Ni un párrafo: loop-voice
 * todavía no existe y este hueco está en pantalla desde el primer segundo del
 * pitch, así que tiene que verse deliberado, no a medio construir.
 *
 * EL ALTO ES DEL TRANSCRIPT. Durante los 60 segundos de llamada en vivo la
 * conversación es lo único que el público lee, así que es el único hijo elástico
 * del panel y todos los demás son `shrink-0` con la altura mínima que su
 * contenido permite. La tarjeta de cobertura, que es su vecina en la columna, se
 * colapsa a su encabezado mientras no haya respuesta de Stedi por la misma
 * razón: a 1280x720 la columna mide 567px y lo que no gasta uno se lo queda el
 * otro.
 */

import { useEffect, useRef } from 'react';

import type { PatientSummary } from '@loop/shared/contracts';

import { Card, EmptyState } from '@/components/Card';
import { useLiveCall, type ConnectionStatus } from '@/components/LiveCallProvider';
import { DATA, FOOT, STAT, STAT_UNIT } from '@/components/tokens';
import { config } from '@/lib/config';
import { DEMO_CALLS, DEMO_CALL_IDS } from '@/lib/demo-call';
import { formatSd, formatTime, labelOutcome } from '@/lib/format';

/** Solo para el `title` y el lector de pantalla: en pantalla lo dice el punto. */
const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  disabled: 'fallback mode · stream disabled',
  connecting: 'connecting to loop-voice',
  open: 'stream connected',
  retrying: 'waiting for loop-voice',
};

/** `EscalationAction` del contrato → la instrucción, en tres palabras. */
const ACTION_LABEL: Record<string, string> = {
  'advise-911': 'Call 911 now',
  'advise-988': 'Call 988 now',
  'connect-human': 'Connect to a clinician',
};

/* ------------------------------------------------------------------ */
/* Barrera de escalación                                               */
/* ------------------------------------------------------------------ */

/**
 * Coral, no rojo puro: sobre casi-negro el rojo saturado vibra y se lee como
 * error de render. El coral se lee como alarma clínica.
 *
 * Relleno plano, nunca otra capa de vidrio dentro del panel de vidrio.
 */
function EscalationBarrier({ rule, action, at }: { rule: string; action: string; at: string }) {
  return (
    <div
      role="alert"
      className="bloom shrink-0 rounded-tile px-4 py-3"
      style={{ background: 'var(--danger-soft)', border: '1px solid var(--danger-line)' }}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="dot dot-alert" />
        <span className="label" style={{ color: 'var(--danger)' }}>
          Deterministic rule
        </span>
        <span className="label ml-auto">{formatTime(at)}</span>
      </div>

      {/*
        El ID de la regla ES el héroe del panel mientras esté en pantalla: la
        misma clase `.hero` que usa la frecuencia cardiaca cuando no hay
        escalación, no un tamaño intermedio. Antes se pintaba a 17px mientras
        las tres constantes vitales iban a 19px —el panel prometía encogerlas
        para no competir y hacía justo lo contrario—, y a ese tamaño
        `RF-01-CHEST-PAIN-RADIATING` no se lee desde el fondo de la sala.

        Monoespaciado porque es un identificador de máquina, y esa es la
        prueba: escaló un umbral determinista, no la opinión de un modelo.
        `tracking` y `leading` sobreescriben los de `.hero`, que están
        calibrados para cifras cortas y aquí dejarían las dos líneas pegadas.
        `anywhere` porque el ID no cabe en 24rem y una palabra partida se lee
        mejor que una que se sale de la tarjeta.
      */}
      <p
        className="hero mt-2 font-mono leading-[1.06] tracking-[-0.02em]"
        style={{ color: 'var(--danger)', overflowWrap: 'anywhere' }}
      >
        {rule}
      </p>

      <p className={`mt-2 ${DATA} font-medium leading-snug text-ink`}>
        {ACTION_LABEL[action] ?? action}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Biometría                                                           */
/* ------------------------------------------------------------------ */

type Baseline = PatientSummary['baseline'];

/**
 * Color por distancia al baseline personal, no por umbrales absolutos: 118 bpm
 * es una cifra distinta según de quién sea el corazón. Es el único color de
 * texto del panel que no es la escalera de blancos, y se lo gana porque es
 * estado clínico real.
 */
function toneFor(value: number, mean: number, sd: number): string | undefined {
  if (sd <= 0) return undefined;
  const distance = Math.abs((value - mean) / sd);
  if (distance >= 3) return 'var(--danger)';
  if (distance >= 1.5) return 'var(--warn)';
  return undefined;
}

function trendMark(current: number, previous: number | undefined): string {
  if (previous === undefined || current === previous) return '';
  return current > previous ? '▲' : '▼';
}

/** Métrica secundaria: mismo dato, un peldaño por debajo del héroe. */
function MicroVital({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div className="min-w-0">
      <p className="label truncate">{label}</p>
      <p className={`mt-1 ${STAT} text-ink-2`}>
        {Math.round(value)}
        <span className={STAT_UNIT}>{unit}</span>
      </p>
    </div>
  );
}

/**
 * Constante vital en modo escalación: una fila, tamaño de dato terciario y sin
 * etiqueta —la unidad ya dice cuál es—. Con una regla en pantalla la biometría
 * no puede pesar lo mismo que el ID que la disparó.
 */
function TinyVital({ value, unit, tone }: { value: number; unit: string; tone?: string }) {
  return (
    <span className={`${DATA} font-semibold text-ink-2`} style={tone ? { color: tone } : undefined}>
      {Math.round(value)}
      <span className="ml-1 text-2xs font-medium text-ink-3">{unit}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function LiveCallPanel({ baseline }: { baseline: Baseline }) {
  const { state, connection, replay, startReplay, stopReplay } = useLiveCall();
  const scroller = useRef<HTMLDivElement>(null);

  // Auto-scroll al final. Depende del número de turnos y no del array para no
  // reprogramarse en cada tick de biometría.
  //
  // Desplazamiento suave y no un salto: el turno que entra tiene que verse
  // LLEGAR. Con `scrollTop = scrollHeight` la burbuja nueva ya estaba colocada
  // cuando el ojo la encontraba, y el panel parecía una lista que se repinta en
  // vez de una conversación que avanza. Quien pide menos movimiento se lo salta
  // —el mismo trato que `prefers-reduced-motion` recibe en globals.css—.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollTo({ top: element.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
  }, [state.turns.length]);

  const vitals = state.biometrics;
  const escalated = state.escalation !== null;
  const hasCall = state.callId !== null;

  const heartTone = vitals
    ? toneFor(vitals.heartRate, baseline.heartRate.mean, baseline.heartRate.sd)
    : undefined;
  const heartSd =
    vitals && baseline.heartRate.sd > 0
      ? (vitals.heartRate - baseline.heartRate.mean) / baseline.heartRate.sd
      : null;

  // El pie solo aparece cuando tiene algo que decir. Un panel esperando no
  // necesita una línea que repita lo que ya dice el estado vacío.
  const showFoot = hasCall || state.ended !== null || state.dropped > 0;

  return (
    <Card
      title="Live call"
      index={2}
      // Reparto de alto de la columna derecha, en una sola regla.
      //
      // Este panel se queda TODO lo que la cobertura no use, y la cobertura ya
      // no se lo puede comer: colapsa a su encabezado mientras no hay respuesta
      // y tiene techo cuando la hay. Con eso el suelo del panel deja de ser una
      // negociación —eran dos `!min-h` medidos a mano, uno por estado— y pasa a
      // ser aritmética: 567px de columna menos el techo de la cobertura.
      //
      // El `min-h-0` que `Card` trae en su clase base es justo lo que hace falta
      // aquí, así que ya no hay que sobreescribirlo con `!`.
      className="flex-1"
      bodyClassName="flex min-h-0 flex-col gap-2.5 px-5 pb-4"
      actions={
        replay ? (
          <>
            {/* Una llamada de ejemplo no se puede confundir nunca con una real. */}
            <span className="pill pill-warn">Replay</span>
            <button type="button" onClick={stopReplay} className="ghostbtn px-2.5 py-1.5">
              Stop
            </button>
          </>
        ) : (
          <>
            <span
              className="flex items-center"
              title={`${CONNECTION_LABEL[connection]} · ${config.voiceUrl}`}
            >
              <span aria-hidden className={`dot ${connection === 'open' ? 'dot-live' : ''}`} />
              <span className="sr-only">{CONNECTION_LABEL[connection]}</span>
            </span>
            {DEMO_CALL_IDS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => startReplay(id)}
                className="ghostbtn px-2.5 py-1.5"
              >
                {DEMO_CALLS[id].label}
              </button>
            ))}
          </>
        )
      }
    >
      {state.escalation ? (
        <EscalationBarrier
          rule={state.escalation.rule}
          action={state.escalation.action}
          at={state.escalation.at}
        />
      ) : null}

      {/* Biometría. En modo normal sigue siendo el héroe del panel, pero ocupa
          una fila y no tres: la distancia al baseline se fue a la MISMA línea
          que la etiqueta —es el pie de foto de la cifra, no un dato aparte— y
          eso devuelve ~24px al transcript sin tocar el tamaño del número. */}
      {vitals ? (
        <div
          className={`tile flex shrink-0 gap-4 px-4 ${escalated ? 'items-baseline py-2' : 'items-end py-2.5'}`}
        >
          {escalated ? (
            // Con una regla disparada la biometría se encoge a una sola fila:
            // el héroe es el ID de arriba y aquí no puede haber un segundo.
            <>
              <TinyVital
                value={vitals.heartRate}
                unit={baseline.heartRate.unit}
                tone={heartTone}
              />
              <TinyVital value={vitals.hrv} unit={baseline.hrv.unit} />
              <TinyVital
                value={vitals.respiratoryRate}
                unit={baseline.respiratoryRate.unit}
              />
            </>
          ) : (
            <>
              <div className="min-w-0 flex-1">
                {/* Etiqueta y contexto en el mismo renglón: "Heart rate" dice
                    qué es y "+2.4σ · baseline 72" dice si es mucho, y las dos
                    cosas se leen antes de bajar a la cifra. Apiladas costaban
                    una tercera línea para no añadir ni un dato. */}
                <p className="label flex items-baseline gap-2 truncate">
                  <span className="shrink-0">Heart rate</span>
                  <span className="truncate font-normal" style={{ color: heartTone }}>
                    <span aria-hidden>
                      {trendMark(vitals.heartRate, state.previousBiometrics?.heartRate)}{' '}
                    </span>
                    {formatSd(heartSd)}
                    <span className="text-ink-3">
                      {' '}
                      · baseline {Math.round(baseline.heartRate.mean)}
                    </span>
                  </span>
                </p>
                <p className="hero mt-1.5" style={{ color: heartTone }}>
                  {Math.round(vitals.heartRate)}
                  <small>{baseline.heartRate.unit}</small>
                </p>
              </div>

              <div className="flex shrink-0 gap-4">
                <MicroVital label="HRV" value={vitals.hrv} unit={baseline.hrv.unit} />
                <MicroVital
                  label="Resp."
                  value={vitals.respiratoryRate}
                  unit={baseline.respiratoryRate.unit}
                />
              </div>
            </>
          )}
        </div>
      ) : null}

      {/*
        Transcript. ÚNICO hijo elástico del panel — todo lo que sobra acaba
        aquí— y sin suelo propio: el suelo se lo garantiza la aritmética de la
        columna (ver el `className` de la Card), no un `min-h` que podría
        empujar al pie fuera de la tarjeta cuando la barrera de escalación
        aparece.

        `pr-1` para que la barra de scroll de 6px no se coma el borde derecho de
        las burbujas del agente.
      */}
      <div ref={scroller} className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {state.turns.length === 0 ? (
          <EmptyState>{hasCall ? 'Call open, no turns yet' : 'No active call'}</EmptyState>
        ) : (
          state.turns.map((turn, index) => {
            const key = `${turn.at}-${index}`;

            if (turn.speaker === 'system') {
              return (
                <p
                  key={key}
                  className="mx-auto max-w-[92%] text-center text-2xs leading-relaxed text-ink-3"
                >
                  {turn.text}
                </p>
              );
            }

            /*
              Sin etiquetas de hablante: quién habla lo dicen el lado, la esquina
              mordida y el fondo. Poner "PACIENTE:" encima sería decir dos veces
              lo mismo, y en mayúsculas.

              La diferencia se llevó del TEXTO al FONDO. El paciente se pintaba
              en teal sólido sobre la misma tesela gris que el agente: media
              columna de texto de color, que en una pantalla que se mira con el
              pulso a 120 es exactamente el tipo de saturación que hay que
              guardar para el badge de escalación. Ahora el paciente es una
              burbuja teñida —fondo `--accent-soft`, filete `--accent-line`— con
              el texto en blanco pleno, y el agente sigue siendo tesela plana con
              texto un peldaño más bajo. Se distinguen mejor que antes y el
              único color saturado de la pantalla sigue siendo el rojo de la
              regla.
            */
            const isAgent = turn.speaker === 'agent';
            return (
              <div key={key} className={`flex ${isAgent ? 'justify-end' : 'justify-start'}`}>
                <p
                  className={`max-w-[88%] px-3 py-2 ${DATA} leading-[1.5] ${
                    isAgent
                      ? 'tile rounded-br-[6px] text-ink-2'
                      : 'rounded-tile rounded-bl-[6px] border text-ink'
                  }`}
                  // El agente reusa `.tile`, que ya es el relleno plano estándar
                  // del sistema; el paciente es el único que necesita valores
                  // propios, y son tokens de acento, no colores sueltos.
                  style={
                    isAgent
                      ? undefined
                      : { background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }
                  }
                >
                  <span className="sr-only">{isAgent ? 'Loop: ' : 'Patient: '}</span>
                  {turn.text}
                </p>
              </div>
            );
          })
        )}
      </div>

      {/* Pie técnico. El contador de descartados sube solo si loop-voice emite
          algo fuera del Contrato 5 — es un aviso de integración, no adorno. */}
      {showFoot ? (
        <div className={`flex shrink-0 items-baseline gap-2 ${FOOT}`}>
          {/* Durante un replay el estado del stream no viene a cuento: lo que
              está pasando en pantalla no sale de él, y decir "waiting for
              loop-voice" mientras corre una llamada se contradice solo. */}
          <span className="truncate">
            {state.ended
              ? `${labelOutcome(state.ended.outcome)} · ${Math.round(state.ended.durationSeconds / 60)} min`
              : replay
                ? ''
                : CONNECTION_LABEL[connection]}
          </span>
          <span className="ml-auto shrink-0 truncate">
            {state.callId ?? config.voiceUrl.replace(/^https?:\/\//, '')}
            {state.dropped > 0 ? ` · ${state.dropped} dropped` : ''}
          </span>
        </div>
      ) : null}
    </Card>
  );
}
