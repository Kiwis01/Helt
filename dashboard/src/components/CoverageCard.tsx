'use client';

/**
 * Tarjeta de cobertura — la respuesta de Stedi.
 *
 * Se alimenta de dos sitios y los distingue en pantalla:
 *
 * - El evento `coverage.check` del SSE, que es LO QUE PASÓ EN LA LLAMADA. Es la
 *   fuente de verdad de status, copago y `voiceSummary`.
 * - Una consulta directa a loop-coverage (:3003), que trae los campos que el
 *   evento del Contrato 5 no lleva: plan, coinsurance, deducible completo y
 *   autorización previa. Se dispara sola al llegar el evento, para que la
 *   tarjeta esté entera en el segundo 1:10 del pitch sin tocar nada.
 *
 * La regla de mezcla no es cosmética: si la consulta directa devuelve un status
 * distinto al del evento (por ejemplo `unknown` porque el sandbox se cayó entre
 * medias), sus campos se descartan y solo se conserva lo que el paciente oyó.
 * Enseñar un deducible de una respuesta que contradice a la otra sería el tipo
 * de detalle que un juez sí nota.
 *
 * El `voiceSummary` se muestra textualmente por eso mismo: verlo escrito al
 * lado de los números es la prueba de que el agente no inventó el copago.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CoverageStatus, Deductible } from '@loop/shared/contracts';

import { Card } from '@/components/Card';
import { useLiveCall } from '@/components/LiveCallProvider';
import type { DataSource } from '@/lib/core-client';
import { checkCoverage, describeCoverageReason } from '@/lib/coverage-client';
import { EMPTY, formatCents, formatDateTime, formatPercent } from '@/lib/format';

const STATUS_LABEL: Record<CoverageStatus, string> = {
  covered: 'Cubierto',
  'not-covered': 'No cubierto',
  'needs-auth': 'Requiere autorización',
  unknown: 'Sin verificar',
};

const STATUS_TINT: Record<CoverageStatus, string> = {
  covered: 'tint-ok',
  'not-covered': 'tint-danger',
  'needs-auth': 'tint-warn',
  unknown: '',
};

const STATUS_COLOR: Record<CoverageStatus, string> = {
  covered: 'var(--ok)',
  'not-covered': 'var(--danger)',
  'needs-auth': 'var(--warn)',
  unknown: 'var(--ink-3)',
};

interface CoverageView {
  status: CoverageStatus;
  payerName: string | null;
  planName: string | null;
  copayCents: number | null;
  coinsurancePercent: number | null;
  deductible: Deductible | null;
  /** Cuando solo se conoce el restante (viene del evento SSE, sin el total). */
  deductibleRemainingCents: number | null;
  priorAuthRequired: boolean | null;
  voiceSummary: string | null;
  latencyMs: number | null;
  checkId: string;
  checkedAt: string | null;
  origin: 'llamada en curso' | 'consulta del dashboard';
  detailSource: DataSource | null;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="text-2xs uppercase tracking-[0.1em] text-ink-3">{label}</p>
      <p className="mt-0.5 truncate text-base font-semibold leading-tight" style={{ color: tone ?? 'var(--ink)' }}>
        {value}
      </p>
    </div>
  );
}

export function CoverageCard() {
  const { state } = useLiveCall();
  const event = state.coverage;

  const [detail, setDetail] = useState<Awaited<ReturnType<typeof checkCoverage>> | null>(null);
  const [pending, setPending] = useState(false);
  /** Evita repetir la consulta automática para el mismo checkId. */
  const enrichedFor = useRef<string | null>(null);

  const run = useCallback(async (callId: string | null) => {
    setPending(true);
    setDetail(await checkCoverage(callId));
    setPending(false);
  }, []);

  useEffect(() => {
    if (!event || enrichedFor.current === event.checkId) return;
    enrichedFor.current = event.checkId;
    void run(event.callId);
  }, [event, run]);

  const view = useMemo<CoverageView | null>(() => {
    if (!event && !detail) return null;

    const full = detail?.data ?? null;
    // Solo se confía en los campos extra si la consulta directa cuenta la misma
    // historia que lo que el paciente escuchó.
    const trusted = full && (!event || full.status === event.status) ? full : null;

    if (event) {
      return {
        status: event.status,
        payerName: event.payerName ?? trusted?.payerName ?? null,
        planName: trusted?.planName ?? null,
        copayCents: event.copayCents ?? trusted?.copayCents ?? null,
        coinsurancePercent: trusted?.coinsurancePercent ?? null,
        deductible: trusted?.deductible ?? null,
        deductibleRemainingCents:
          event.deductibleRemainingCents ?? trusted?.deductible?.remainingCents ?? null,
        priorAuthRequired: trusted?.priorAuthRequired ?? null,
        voiceSummary: event.voiceSummary ?? trusted?.voiceSummary ?? null,
        latencyMs: trusted?.latencyMs ?? null,
        checkId: event.checkId,
        checkedAt: event.at,
        origin: 'llamada en curso',
        detailSource: detail?.source ?? null,
      };
    }

    if (!full) return null;
    return {
      status: full.status,
      payerName: full.payerName,
      planName: full.planName,
      copayCents: full.copayCents,
      coinsurancePercent: full.coinsurancePercent,
      deductible: full.deductible,
      deductibleRemainingCents: full.deductible?.remainingCents ?? null,
      priorAuthRequired: full.priorAuthRequired,
      voiceSummary: full.voiceSummary,
      latencyMs: full.latencyMs,
      checkId: full.checkId,
      checkedAt: full.checkedAt,
      origin: 'consulta del dashboard',
      detailSource: detail?.source ?? null,
    };
  }, [event, detail]);

  const actions = (
    <>
      {view ? (
        <span
          className={`flex items-center gap-1.5 rounded-md border border-line-strong px-2 py-1 ${STATUS_TINT[view.status]}`}
        >
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: STATUS_COLOR[view.status] }}
          />
          <span
            className="text-2xs font-semibold uppercase tracking-[0.1em]"
            style={{ color: STATUS_COLOR[view.status] }}
          >
            {STATUS_LABEL[view.status]}
          </span>
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => void run(state.callId)}
        disabled={pending}
        className="rounded-md border border-line-strong px-2 py-1 text-2xs font-medium text-ink-2 transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? 'Consultando…' : 'Verificar'}
      </button>
    </>
  );

  if (!view) {
    return (
      <Card title="Cobertura" subtitle="Stedi" actions={actions} className="shrink">
        <div className="flex flex-col items-center justify-center gap-1.5 py-3 text-center">
          <p className="text-sm font-medium text-ink-2">
            Sin verificación de cobertura en esta llamada
          </p>
          <p className="max-w-[19rem] text-xs leading-relaxed text-ink-3">
            La tarjeta se rellena sola cuando el agente pregunta por el coste de la visita de
            telesalud. También se puede consultar a mano con «Verificar».
          </p>
        </div>
      </Card>
    );
  }

  /** El detalle llegó del fixture, no de loop-coverage. Cambia lo que es honesto enseñar. */
  const isFixture = detail !== null && detail.source === 'fixture';

  const met = view.deductible ? view.deductible.metCents : null;
  const total = view.deductible ? view.deductible.individualCents : null;
  const progress = met !== null && total ? Math.min(100, Math.max(0, (met / total) * 100)) : null;

  return (
    <Card
      title="Cobertura"
      subtitle="Stedi"
      actions={actions}
      // `shrink` + scroll interno: si el panel en vivo necesita el alto (badge
      // de escalación en pantalla), esta tarjeta cede y hace scroll en vez de
      // desbordar la columna.
      className="shrink"
      bodyClassName="flex min-h-0 flex-col gap-1.5 overflow-y-auto p-3"
    >
      <div className="flex shrink-0 items-baseline justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-semibold text-ink">
          {view.payerName ?? 'Pagador no identificado'}
        </p>
        <p className="shrink-0 text-2xs text-ink-3">{view.planName ?? EMPTY}</p>
      </div>

      <div className="flex shrink-0 items-start gap-3">
        <Stat label="Copago" value={formatCents(view.copayCents)} />
        <Stat label="Coinsurance" value={formatPercent(view.coinsurancePercent)} />
        <Stat
          label="Autorización"
          value={
            view.priorAuthRequired === null
              ? EMPTY
              : view.priorAuthRequired
                ? 'Requerida'
                : 'No requerida'
          }
          tone={view.priorAuthRequired ? 'var(--warn)' : undefined}
        />
      </div>

      <div className="shrink-0">
        <div className="flex items-baseline justify-between gap-2 text-2xs">
          <span className="shrink-0 uppercase tracking-[0.1em] text-ink-3">Deducible</span>
          <span className="truncate text-ink-2">
            {met !== null && total !== null
              ? `${formatCents(met)} de ${formatCents(total)}`
              : 'sin el total en el evento'}
            {view.deductibleRemainingCents !== null
              ? ` · quedan ${formatCents(view.deductibleRemainingCents)}`
              : ''}
          </span>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2">
          {progress !== null ? (
            <div
              className="h-full rounded-full"
              style={{ width: `${progress}%`, backgroundColor: 'var(--accent)' }}
            />
          ) : null}
        </div>
      </div>

      {view.voiceSummary ? (
        <figure className="tint-accent min-h-0 shrink-0 rounded-md border-l-2 border-accent px-3 py-2">
          <blockquote className="text-xs italic leading-snug text-ink">
            «{view.voiceSummary}»
          </blockquote>
          <figcaption className="mt-1 text-2xs text-ink-3">
            literal, lo que el agente le leyó al paciente
          </figcaption>
        </figure>
      ) : null}

      {/*
        Pie en dos mitades y cada una con su propio `truncate`.

        Antes iba todo en una línea y lo primero que se cortaba era justo el
        aviso de que la respuesta venía de un fixture — el único dato del pie
        que no se puede perder. Por lo mismo, con fixture no se enseña la
        latencia: 812 ms es el número que traía el archivo, no lo que tardó una
        llamada que no ha ocurrido.
      */}
      <p className="mt-auto flex shrink-0 items-baseline justify-between gap-2 font-mono text-2xs text-ink-3">
        <span className="min-w-0 truncate">
          {isFixture
            ? `fixture · ${describeCoverageReason(detail.reason)}`
            : `${view.origin} · ${formatDateTime(view.checkedAt)}`}
        </span>
        <span className="shrink-0">
          {view.checkId}
          {!isFixture && view.latencyMs !== null ? ` · ${view.latencyMs} ms` : ''}
        </span>
      </p>
    </Card>
  );
}
