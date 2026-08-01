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

import { Card } from '@/components/Card';
import { useLiveCall } from '@/components/LiveCallProvider';
import { DATA, FOOT } from '@/components/tokens';
import type { DataSource } from '@/lib/core-client';
import { checkCoverage, describeCoverageReason } from '@/lib/coverage-client';
import { formatCents, formatDateTime, formatPercent } from '@/lib/format';

const STATUS_LABEL: Record<CoverageStatus, string> = {
  covered: 'Covered',
  'not-covered': 'Not covered',
  'needs-auth': 'Prior auth required',
  unknown: 'Unknown',
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
  origin: 'call in progress' | 'dashboard check';
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
        origin: 'call in progress',
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
      origin: 'dashboard check',
      detailSource: detail?.source ?? null,
    };
  }, [event, detail]);

  /*
   * La píldora del encabezado es EL MISMO HUECO antes y después de la
   * respuesta: primero dice "no check yet" en gris y luego se convierte en
   * "Covered". Que el estado viva siempre en el mismo sitio y solo cambie de
   * texto es lo que hace que la llegada de la 271 se lea como una transición y
   * no como la aparición de una tarjeta nueva.
   */
  const actions = (
    <>
      {view ? (
        <span className={`pill ${STATUS_PILL[view.status]}`}>{STATUS_LABEL[view.status]}</span>
      ) : (
        <span className="pill pill-quiet">No check yet</span>
      )}
      <button
        type="button"
        onClick={() => void run(state.callId)}
        disabled={pending}
        className="ghostbtn px-2.5 py-1.5"
      >
        {pending ? 'Checking…' : 'Check'}
      </button>
    </>
  );

  /*
   * Sin respuesta, esta tarjeta es UNA LÍNEA.
   *
   * Antes se llevaba ~20% del alto de la columna para escribir "No check on
   * this call" centrado en un rectángulo vacío — y lo hacía justo durante los
   * 60 segundos de llamada en vivo, que es cuando el alto de esa columna es lo
   * más disputado de la pantalla. El estado vacío no ha desaparecido: lo dice
   * la píldora del encabezado, en tres palabras y sin gastar un solo píxel de
   * más. Todo lo que suelta aquí se lo queda el transcript, que es lo que el
   * público está mirando.
   *
   * `shrink-0` porque a un encabezado no le queda nada que ceder.
   */
  if (!view) {
    return <Card title="Coverage" subtitle="Stedi" actions={actions} index={3} className="shrink-0" />;
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
      title="Coverage"
      subtitle="Stedi"
      actions={actions}
      index={3}
      /*
       * Techo, no fracción.
       *
       * La tarjeta crece a lo que mide su contenido y ahí se para: el panel en
       * vivo es `flex-1` y se queda todo lo demás, así que este número es
       * literalmente el peor caso del transcript. 15.5rem = 248px deja al panel
       * 319px garantizados a 1280x720 —header, biometría, pie y aún ~140px de
       * conversación— y es lo que ocupa la tarjeta entera menos la última fila
       * de contexto, que es justo el primer hijo que este componente ya tenía
       * decidido sacrificar.
       *
       * Con una regla disparada el techo baja a 12rem: ahí dentro solo quedan
       * copago, deducible y pie (ver `standDown`), y los 56px que suelta se los
       * lleva la barrera de escalación, que es `shrink-0` y no admite quedarse a
       * medias.
       *
       * `shrink-0` para que el techo sea el único que manda: sin él el navegador
       * podría recortar por debajo y volver a partir el héroe del copago.
       */
      className={`shrink-0 ${standDown ? 'max-h-[12rem]' : 'max-h-[15.5rem]'}`}
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
            <p className="label">Copay</p>
            <p
              className="hero mt-1.5"
              style={view.copayCents === null ? { color: 'var(--ink-3)' } : undefined}
            >
              {formatCents(view.copayCents)}
            </p>
          </div>

          {hasDeductible ? (
            <div className="min-w-0 flex-1 border-l border-hair pl-4">
              <p className="label">Deductible</p>
              <p className={`mt-1.5 truncate ${DATA} font-medium text-ink-2`}>
                {view.deductibleRemainingCents !== null ? (
                  <>
                    {formatCents(view.deductibleRemainingCents)}{' '}
                    <span className="text-ink-3">remaining</span>
                  </>
                ) : (
                  `${formatCents(met)} of ${formatCents(total)}`
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
              “{view.voiceSummary}”
            </blockquote>
            <figcaption className="label mt-1.5">read to the patient</figcaption>
          </figure>
        ) : null}

        {/* El único hijo elástico: se queda el espacio sobrante —que es lo que
            empuja el pie hasta abajo— y es el primero en cederlo. */}
        <div className="flex min-h-0 flex-1 flex-wrap content-start gap-x-5 gap-y-2.5 overflow-hidden">
          {standDown ? null : (
            <>
              <Fact label="Payer" value={view.payerName} />
              <Fact label="Plan" value={view.planName} />
              <Fact
                label="Coinsurance"
                value={
                  view.coinsurancePercent === null ? null : formatPercent(view.coinsurancePercent)
                }
              />
              <Fact
                label="Prior auth"
                value={
                  view.priorAuthRequired === null
                    ? null
                    : view.priorAuthRequired
                      ? 'Required'
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
