'use client';

/**
 * Panel de llamada en vivo — lo que se ve entre 0:10 y 2:00 del demo.
 *
 * Consume el estado que `LiveCallProvider` alimenta desde el SSE de loop-voice
 * (Contrato 5) o desde el guion de replay. Aquí no hay lógica de red ni de
 * seguridad: este componente solo PINTA. En concreto, no calcula ninguna
 * red-flag — el badge de escalación se dibuja únicamente cuando llega el evento
 * `safety.escalation`, porque quien decide es una regla determinista de
 * loop-voice y el dashboard no puede dar la impresión de opinar sobre eso.
 *
 * El estado por defecto es "sin llamada activa" y tiene que verse deliberado:
 * hoy loop-voice todavía no existe y este panel está en pantalla desde el
 * primer segundo del pitch. Un panel vacío que parece roto cuesta más que uno
 * que dice con calma que está esperando.
 */

import { useEffect, useRef } from 'react';

import type { PatientSummary } from '@loop/shared/contracts';

import { Card } from '@/components/Card';
import { useLiveCall, type ConnectionStatus } from '@/components/LiveCallProvider';
import { config } from '@/lib/config';
import { DEMO_CALLS, DEMO_CALL_IDS } from '@/lib/demo-call';
import { formatTime, labelOutcome } from '@/lib/format';

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  disabled: 'modo respaldo · stream desactivado',
  connecting: 'conectando con loop-voice…',
  open: 'stream conectado',
  retrying: 'esperando a loop-voice',
};

const CONNECTION_COLOR: Record<ConnectionStatus, string> = {
  disabled: 'var(--ink-3)',
  connecting: 'var(--warn)',
  open: 'var(--ok)',
  retrying: 'var(--ink-3)',
};

/** `EscalationAction` del contrato → lo que hay que leer en pantalla. */
const ACTION_LABEL: Record<string, string> = {
  'advise-911': 'Indicar al paciente que llame al 911',
  'advise-988': 'Indicar al paciente que llame al 988',
  'connect-human': 'Conectar con un clínico humano',
};

/* ------------------------------------------------------------------ */
/* Badge de escalación                                                 */
/* ------------------------------------------------------------------ */

/**
 * El ID de la regla es el elemento más grande del badge a propósito.
 *
 * Los jueces necesitan ver que la escalación la disparó una REGLA con nombre y
 * no la decisión de un modelo. Si lo más prominente fuese el texto de la
 * acción, el badge contaría lo que pasó pero no lo que importa: que fue
 * determinista y auditable.
 */
function EscalationBadge({ rule, action, at }: { rule: string; action: string; at: string }) {
  return (
    <div
      className="tint-danger shrink-0 rounded-md border px-3 py-2"
      style={{ borderColor: 'var(--danger)' }}
      role="alert"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="size-1.5 shrink-0 animate-pulse rounded-full"
          style={{ backgroundColor: 'var(--danger)' }}
        />
        <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-danger">
          Escalación determinista
        </p>
      </div>

      <p className="mt-1 break-all font-mono text-base font-bold leading-tight tracking-tight text-danger">
        {rule}
      </p>

      <p className="mt-1 text-xs font-medium leading-snug text-ink">
        {ACTION_LABEL[action] ?? action}
      </p>
      <p className="mt-0.5 text-2xs leading-snug text-ink-3">
        regla evaluada antes de invocar al modelo · {formatTime(at)}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Biometría en vivo                                                   */
/* ------------------------------------------------------------------ */

type Baseline = PatientSummary['baseline'];

function trendMark(current: number, previous: number | undefined): string {
  if (previous === undefined || current === previous) return '·';
  return current > previous ? '▲' : '▼';
}

/**
 * Color por distancia al baseline personal, no por umbrales absolutos: 118 bpm
 * es una cifra distinta según de quién sea el corazón.
 */
function toneFor(value: number, mean: number, sd: number): string {
  if (sd <= 0) return 'var(--ink)';
  const distance = Math.abs((value - mean) / sd);
  if (distance >= 3) return 'var(--danger)';
  if (distance >= 1.5) return 'var(--warn)';
  return 'var(--ink)';
}

function Vital({
  label,
  value,
  unit,
  previous,
  mean,
  sd,
}: {
  label: string;
  value: number;
  unit: string;
  previous: number | undefined;
  mean: number;
  sd: number;
}) {
  const mark = trendMark(value, previous);
  const tone = toneFor(value, mean, sd);
  const sdFrom = sd > 0 ? (value - mean) / sd : 0;

  return (
    <div className="min-w-0 flex-1">
      <p className="text-2xs uppercase tracking-[0.1em] text-ink-3">{label}</p>
      <p className="mt-0.5 flex items-baseline gap-1">
        <span className="text-xl font-semibold leading-none" style={{ color: tone }}>
          {Math.round(value)}
        </span>
        <span className="text-2xs text-ink-3">{unit}</span>
        <span className="ml-auto text-2xs" style={{ color: tone }} aria-hidden>
          {mark}
        </span>
      </p>
      <p className="mt-0.5 truncate text-2xs text-ink-3">
        {sdFrom > 0 ? '+' : ''}
        {sdFrom.toFixed(1)} SD
      </p>
    </div>
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

  const hasCall = state.callId !== null;
  const vitals = state.biometrics;

  return (
    <Card
      title="Llamada en vivo"
      // Se queda con el alto que la tarjeta de cobertura no use, pero nunca
      // baja de lo que necesitan badge + biometría + una burbuja legible.
      className="min-h-[17rem] flex-1"
      bodyClassName="flex min-h-0 flex-col"
      actions={
        <>
          <span
            className="flex items-center gap-1.5"
            title={`${CONNECTION_LABEL[connection]} · ${config.voiceUrl}`}
          >
            <span
              aria-hidden
              className={`size-2 shrink-0 rounded-full ${connection === 'open' ? 'animate-pulse' : ''}`}
              style={{ backgroundColor: CONNECTION_COLOR[connection] }}
            />
            <span className="sr-only">{CONNECTION_LABEL[connection]}</span>
          </span>

          {replay ? (
            <button
              type="button"
              onClick={stopReplay}
              className="rounded-md border border-line-strong px-2 py-1 text-2xs font-medium text-warn transition-colors hover:tint-warn"
            >
              Detener
            </button>
          ) : (
            DEMO_CALL_IDS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => startReplay(id)}
                title={DEMO_CALLS[id].description}
                className="rounded-md border border-line-strong px-2 py-1 text-2xs font-medium text-ink-2 transition-colors hover:bg-surface-2"
              >
                {DEMO_CALLS[id].label}
              </button>
            ))
          )}
        </>
      }
    >
      {/* Aviso de reproducción. Va arriba del todo y en ámbar porque una
          llamada de ejemplo no se puede confundir nunca con una real. Una sola
          línea: el detalle va en el `title`, porque en este panel cada píxel de
          alto se lo quita al transcript. */}
      {replay ? (
        <p
          className="tint-warn shrink-0 truncate border-b border-line px-3 py-1 text-2xs text-warn"
          title={DEMO_CALLS[replay].description}
        >
          <span className="font-semibold uppercase tracking-[0.12em]">Reproducción</span> · llamada
          grabada, no es una llamada real
        </p>
      ) : null}

      {state.escalation ? (
        <div className="shrink-0 p-2.5 pb-0">
          <EscalationBadge
            rule={state.escalation.rule}
            action={state.escalation.action}
            at={state.escalation.at}
          />
        </div>
      ) : null}

      {vitals ? (
        <div className="flex shrink-0 items-start gap-3 border-b border-line px-3 py-2">
          <Vital
            label="HR"
            value={vitals.heartRate}
            unit={baseline.heartRate.unit}
            previous={state.previousBiometrics?.heartRate}
            mean={baseline.heartRate.mean}
            sd={baseline.heartRate.sd}
          />
          <Vital
            label="HRV"
            value={vitals.hrv}
            unit={baseline.hrv.unit}
            previous={state.previousBiometrics?.hrv}
            mean={baseline.hrv.mean}
            sd={baseline.hrv.sd}
          />
          <Vital
            label="RR"
            value={vitals.respiratoryRate}
            unit={baseline.respiratoryRate.unit}
            previous={state.previousBiometrics?.respiratoryRate}
            mean={baseline.respiratoryRate.mean}
            sd={baseline.respiratoryRate.sd}
          />
        </div>
      ) : null}

      {/* Transcript. El `min-h` evita que el badge de escalación y la biometría
          —ambos `shrink-0`— lo aplasten a cero cuando coinciden en pantalla:
          una burbuja cortada por la mitad se lee como un panel roto. */}
      <div ref={scroller} className="min-h-[5.5rem] flex-1 space-y-2 overflow-y-auto p-3">
        {state.turns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <span
              aria-hidden
              className="size-2.5 rounded-full"
              style={{ backgroundColor: CONNECTION_COLOR[connection] }}
            />
            <p className="text-sm font-medium text-ink-2">
              {hasCall ? 'Llamada abierta, sin turnos todavía' : 'Sin llamada activa'}
            </p>
            <p className="max-w-[17rem] text-xs leading-relaxed text-ink-3">
              El transcript, la biometría y las alertas aparecen aquí en cuanto loop-voice abra el
              stream. Mientras tanto, «Replay» reproduce una llamada de ejemplo.
            </p>
          </div>
        ) : (
          state.turns.map((turn, index) => {
            const key = `${turn.at}-${index}`;

            if (turn.speaker === 'system') {
              return (
                <p
                  key={key}
                  className="mx-auto max-w-[92%] text-center text-2xs italic leading-relaxed text-ink-3"
                >
                  {turn.text}
                </p>
              );
            }

            const isAgent = turn.speaker === 'agent';
            return (
              <div key={key} className={`flex ${isAgent ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[88%] rounded-lg px-2.5 py-1.5 ${
                    isAgent ? 'tint-accent rounded-br-sm' : 'rounded-bl-sm bg-surface-2'
                  }`}
                >
                  <p className="text-xs leading-relaxed text-ink">{turn.text}</p>
                  <p className="mt-1 text-2xs text-ink-3">
                    {isAgent ? 'Loop' : 'Paciente'} · {formatTime(turn.at)}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Pie: estado técnico honesto. El contador de descartados sube solo si
          loop-voice emite algo fuera del Contrato 5 — es un aviso de
          integración, no decoración. */}
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1.5 text-2xs text-ink-3">
        <span className="truncate">
          {state.ended
            ? `${labelOutcome(state.ended.outcome)} · ${Math.round(state.ended.durationSeconds / 60)} min`
            : CONNECTION_LABEL[connection]}
        </span>
        <span className="ml-auto shrink-0 truncate font-mono">
          {state.callId ?? config.voiceUrl.replace(/^https?:\/\//, '')}
          {state.dropped > 0 ? ` · ${state.dropped} descartados` : ''}
        </span>
      </div>
    </Card>
  );
}
