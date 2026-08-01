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
  disabled: 'modo respaldo · stream desactivado',
  connecting: 'conectando con loop-voice',
  open: 'stream conectado',
  retrying: 'esperando a loop-voice',
};

/** `EscalationAction` del contrato → la instrucción, en tres palabras. */
const ACTION_LABEL: Record<string, string> = {
  'advise-911': 'Llamar al 911 ahora',
  'advise-988': 'Llamar al 988',
  'connect-human': 'Conectar con un clínico',
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
          Regla determinista
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
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
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
      title="Llamada en vivo"
      index={2}
      // Reparto de alto de la columna derecha. La columna mide 564px a 1280x720
      // y las dos tarjetas juntas piden más, así que quién cede está decidido
      // aquí y no lo improvisa el navegador:
      //
      // - `flex-[1_0_0%]`: este panel crece hasta llenar lo que la cobertura no
      //   use, pero NUNCA encoge. Antes era `flex-auto` con suelo de 16rem, y
      //   con el transcript lleno su base de contenido llegaba a 388px dejando
      //   158px a una cobertura que pedía 256: el héroe del copago salía
      //   partido por la mitad.
      // - Los dos suelos son medidos, no redondeados a ojo. 17rem = 272px es lo
      //   que ocupan cabecera + biometría + una burbuja + pie. 19rem = 304px
      //   añade la barrera de escalación, que es `shrink-0` y no admite quedarse
      //   a medias. Por debajo de eso el contenido se saldría de la tarjeta.
      // - `!` porque `Card` trae `min-h-0` en su clase base y las dos reglas
      //   pesan lo mismo; el orden en la hoja no es algo que se deba suponer.
      className={`flex-[1_0_0%] ${escalated ? '!min-h-[19rem]' : '!min-h-[17rem]'}`}
      bodyClassName="flex min-h-0 flex-col gap-2.5 px-5 pb-4"
      actions={
        replay ? (
          <>
            {/* Una llamada de ejemplo no se puede confundir nunca con una real. */}
            <span className="pill pill-warn">Reproducción</span>
            <button type="button" onClick={stopReplay} className="ghostbtn px-2.5 py-1.5">
              Detener
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

      {vitals ? (
        <div
          className={`tile flex shrink-0 gap-4 px-4 ${escalated ? 'items-baseline py-2' : 'items-end py-3'}`}
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
                <p className="label">Frecuencia cardiaca</p>
                <p className="hero mt-1.5" style={{ color: heartTone }}>
                  {Math.round(vitals.heartRate)}
                  <small>{baseline.heartRate.unit}</small>
                </p>
                <p className="mt-1.5 flex items-baseline gap-1.5 text-2xs text-ink-3">
                  <span aria-hidden style={{ color: heartTone }}>
                    {trendMark(vitals.heartRate, state.previousBiometrics?.heartRate)}
                  </span>
                  <span style={{ color: heartTone }}>{formatSd(heartSd)}</span>
                  <span>basal {Math.round(baseline.heartRate.mean)}</span>
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

      {/* Transcript. Es el único hijo elástico del panel, y su suelo desaparece
          cuando hay una regla disparada: con la barrera en pantalla lo que hay
          que leer es el ID, no la conversación, y reservarle 3.5rem al
          transcript era empujar a la cobertura hasta recortarle la cita. */}
      <div
        ref={scroller}
        className={`flex-1 space-y-2 overflow-y-auto ${escalated ? 'min-h-0' : 'min-h-[3.5rem]'}`}
      >
        {state.turns.length === 0 ? (
          <EmptyState>{hasCall ? 'Llamada abierta, sin turnos' : 'Sin llamada activa'}</EmptyState>
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

            // Sin etiquetas de hablante: el acento es el paciente y el blanco
            // apagado es el agente. Poner "PACIENTE:" encima sería decir dos
            // veces lo mismo, y en mayúsculas.
            const isAgent = turn.speaker === 'agent';
            return (
              <div key={key} className={`flex ${isAgent ? 'justify-end' : 'justify-start'}`}>
                <p
                  className={`tile max-w-[88%] px-3 py-2 ${DATA} leading-[1.5] ${
                    isAgent ? 'rounded-br-[6px] text-ink-2' : 'rounded-bl-[6px]'
                  }`}
                  style={isAgent ? undefined : { color: 'var(--accent)' }}
                >
                  <span className="sr-only">{isAgent ? 'Loop: ' : 'Paciente: '}</span>
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
              está pasando en pantalla no sale de él, y decir "esperando a
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
            {state.dropped > 0 ? ` · ${state.dropped} descartados` : ''}
          </span>
        </div>
      ) : null}
    </Card>
  );
}
