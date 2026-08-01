'use client';

/**
 * Tarjeta de cobertura — la respuesta de Stedi.
 *
 * El héroe es EL COPAGO. De todo lo que devuelve una 271, "$25" es la única
 * cifra que el paciente estaba preguntando de verdad; pagador, plan, coaseguro
 * y autorización son contexto y se pintan como contexto.
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
 * El `voiceSummary` se muestra textualmente por eso mismo: verlo escrito al lado
 * del número es la prueba de que el agente no lo inventó. Va tratado como cita
 * —cursiva, apagada, filete al margen— y no como otro bloque de texto, porque en
 * cuanto pesa igual que los datos deja de leerse.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CoverageStatus, Deductible } from '@loop/shared/contracts';

import { Card, EmptyState } from '@/components/Card';
import { useLiveCall } from '@/components/LiveCallProvider';
import { DATA, FOOT } from '@/components/tokens';
import type { DataSource } from '@/lib/core-client';
import { checkCoverage, describeCoverageReason } from '@/lib/coverage-client';
import { formatCents, formatDateTime, formatPercent } from '@/lib/format';

const STATUS_LABEL: Record<CoverageStatus, string> = {
  covered: 'Cubierto',
  'not-covered': 'No cubierto',
  'needs-auth': 'Con autorización',
  unknown: 'Sin verificar',
};

/** Una píldora por estado. El color vive aquí y no se repite en los números. */
const STATUS_PILL: Record<CoverageStatus, string> = {
  covered: 'pill-ok',
  'not-covered': 'pill-danger',
  'needs-auth': 'pill-warn',
  unknown: 'pill-quiet',
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

/**
 * Dato secundario. Devuelve `null` cuando no se conoce: una rejilla de guiones
 * largos ocupa el mismo sitio que los datos y no dice nada.
 */
function Fact({ label, value, tone }: { label: string; value: string | null; tone?: string }) {
  if (value === null) return null;
  return (
    <div className="min-w-0">
      <p className="label truncate">{label}</p>
      <p
        className={`mt-0.5 truncate ${DATA} font-medium text-ink-2`}
        style={tone ? { color: tone } : undefined}
      >
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
        <span className={`pill ${STATUS_PILL[view.status]}`}>{STATUS_LABEL[view.status]}</span>
      ) : null}
      <button
        type="button"
        onClick={() => void run(state.callId)}
        disabled={pending}
        className="ghostbtn px-2.5 py-1.5"
      >
        {pending ? 'Consultando…' : 'Verificar'}
      </button>
    </>
  );

  if (!view) {
    return (
      <Card title="Cobertura" subtitle="Stedi" actions={actions} index={3}>
        <EmptyState>Sin verificación en esta llamada</EmptyState>
      </Card>
    );
  }

  /** El detalle llegó del fixture, no de loop-coverage. Cambia lo que es honesto enseñar. */
  const isFixture = detail !== null && detail.source === 'fixture';

  const met = view.deductible ? view.deductible.metCents : null;
  const total = view.deductible ? view.deductible.individualCents : null;
  const progress = met !== null && total ? Math.min(100, Math.max(0, (met / total) * 100)) : null;
  const hasDeductible = view.deductibleRemainingCents !== null || total !== null;

  /*
   * Con una regla de seguridad disparada, esta tarjeta se retira a lo esencial.
   *
   * No es una optimización de píxeles disfrazada: a 1280x720 la columna mide
   * 564px, la barrera de escalación es intocable y el resultado medido es que
   * la cita de Stedi se cortaba a media línea. Antes de dejar que un texto se
   * guillotine, la tarjeta decide qué se va — y con un `advise-911` en pantalla
   * lo que sobra es la letra pequeña del seguro: pagador, plan, coaseguro y la
   * frase textual que se le leyó al paciente.
   *
   * No se esconde nada clínico ni nada que cambie la lectura: el estado sigue
   * en la píldora del encabezado, el copago sigue siendo el héroe, el deducible
   * sigue al lado y el pie sigue diciendo si esto salió de un fixture.
   */
  const standDown = state.escalation !== null;

  return (
    <Card
      title="Cobertura"
      subtitle="Stedi"
      actions={actions}
      index={3}
      // `shrink`: si el panel en vivo necesita el alto (barrera de escalación en
      // pantalla), esta tarjeta cede en vez de desbordar la columna. Lo que cede
      // por dentro está decidido abajo, hijo por hijo.
      className="shrink"
      bodyClassName="flex min-h-0 flex-col px-5 pb-4"
    >
      {/*
        NADA DE SCROLL INTERNO. Nadie hace scroll en un proyector: lo que queda
        fuera del alto disponible está perdido igual, y una barra que lo esconde
        solo hace creer que la tarjeta cabe. Así que aquí se decide explícitamente
        QUÉ se pierde, hijo por hijo, y en este orden:

          1. la fila de contexto —pagador, plan, coaseguro, autorización— es el
             único hijo elástico y por tanto lo primero que se va;
          2. con una regla disparada se retiran también esa fila y la cita, que
             es la única situación en la que no caben (ver `standDown`);
          3. el copago no cede nunca;
          4. el pie vive FUERA de esta zona, más abajo, porque el aviso de que la
             respuesta salió de un fixture no se puede perder jamás.

        `overflow-hidden` es la red final: si algún día no cupiera ni lo
        intocable, se recorta dentro de la tarjeta en vez de derramarse sobre la
        columna.
      */}
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden">
        {/*
          Copago y deducible en la MISMA fila, no apilados: son la misma pregunta
          —cuánto pago hoy— y apilados costaban 55 px de alto que a 720 son la
          diferencia entre leer entera la cita de Stedi o no verla. El copago
          sigue siendo el único número héroe; el deducible es texto pequeño al
          lado.
        */}
        <div className="tile flex shrink-0 items-start gap-4 px-4 py-2.5">
          <div className="min-w-0">
            <p className="label">Copago</p>
            <p
              className="hero mt-1.5"
              style={view.copayCents === null ? { color: 'var(--ink-3)' } : undefined}
            >
              {formatCents(view.copayCents)}
            </p>
          </div>

          {hasDeductible ? (
            <div className="min-w-0 flex-1 border-l border-hair pl-4">
              <p className="label">Deducible</p>
              <p className={`mt-1.5 truncate ${DATA} font-medium text-ink-2`}>
                {view.deductibleRemainingCents !== null ? (
                  <>
                    {formatCents(view.deductibleRemainingCents)}{' '}
                    <span className="text-ink-3">restante</span>
                  </>
                ) : (
                  `${formatCents(met)} de ${formatCents(total)}`
                )}
              </p>
              {progress !== null ? (
                <div
                  className="mt-2 h-[3px] overflow-hidden rounded-full"
                  style={{ background: 'rgba(255, 255, 255, 0.08)' }}
                  role="presentation"
                >
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${progress}%`, background: 'var(--accent)' }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* La cita va pegada al número porque es su prueba: el copago de arriba
            es la misma frase que el paciente oyó, palabra por palabra. */}
        {view.voiceSummary && !standDown ? (
          <figure className="shrink-0 border-l pl-3" style={{ borderColor: 'var(--accent-line)' }}>
            <blockquote className={`${DATA} italic leading-snug text-ink-2`}>
              «{view.voiceSummary}»
            </blockquote>
            <figcaption className="label mt-1.5">leído al paciente</figcaption>
          </figure>
        ) : null}

        {/* El único hijo elástico: se queda el espacio sobrante —que es lo que
            empuja el pie hasta abajo— y es el primero en cederlo. */}
        <div className="flex min-h-0 flex-1 flex-wrap content-start gap-x-5 gap-y-2.5 overflow-hidden">
          {standDown ? null : (
            <>
              <Fact label="Pagador" value={view.payerName} />
              <Fact label="Plan" value={view.planName} />
              <Fact
                label="Coaseguro"
                value={
                  view.coinsurancePercent === null ? null : formatPercent(view.coinsurancePercent)
                }
              />
              <Fact
                label="Autorización"
                value={
                  view.priorAuthRequired === null
                    ? null
                    : view.priorAuthRequired
                      ? 'Requerida'
                      : 'No'
                }
                tone={view.priorAuthRequired ? 'var(--warn)' : undefined}
              />
            </>
          )}
        </div>
      </div>

      {/*
        Pie en dos mitades, cada una con su propio `truncate`.

        Fuera de la zona que se recorta —y `shrink-0`— porque el aviso de que la
        respuesta venía de un fixture es el dato que no se puede perder nunca:
        es lo único que separa "Stedi respondió esto" de "esto es un archivo".
        Por lo mismo, con fixture no se enseña la latencia: 812 ms es el número
        que traía el archivo, no lo que tardó una llamada que no ha ocurrido.
      */}
      <p
        className={`mt-2 flex shrink-0 items-baseline justify-between gap-2 border-t border-hair pt-2 ${FOOT}`}
      >
        <span className="min-w-0 truncate">
          {isFixture
            ? `fixture · ${describeCoverageReason(detail.reason)}`
            : `${view.origin} · ${formatDateTime(view.checkedAt)}`}
        </span>
        {/* El checkId cede primero: con un UUID de Stedi ocupa media línea y
            dejaba el aviso de fixture truncado a tres letras. */}
        <span className="max-w-[40%] shrink-0 truncate">
          {view.checkId}
          {!isFixture && view.latencyMs !== null ? ` · ${view.latencyMs} ms` : ''}
        </span>
      </p>
    </Card>
  );
}
