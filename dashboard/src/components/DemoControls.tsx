'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { DemoProfile } from '@loop/shared/contracts';

import { FLOATING_SURFACE } from '@/components/tokens';
import { describeReason, resetDemo, triggerDemoSpike, type DataResult } from '@/lib/core-client';

type ActionId = DemoProfile | 'reset';

interface Feedback {
  tone: 'ok' | 'warn';
  text: string;
}

const SPIKES: readonly { id: DemoProfile; label: string }[] = [
  { id: 'panic', label: 'Pánico' },
  { id: 'cardiac-redflag', label: 'Red-flag cardiaca' },
];

/** El mensaje se va solo: un aviso pegado en pantalla ensucia el siguiente plano. */
const FEEDBACK_TTL_MS = 6_000;

/**
 * Panel de control del demo — Contrato 6.
 *
 * Sin esto el demo en vivo es una ruleta: estos tres botones son los que ponen
 * al paciente en el estado que toca justo antes de cada bloque.
 *
 * Los tres se ven igual (.ghostbtn) a propósito. El reset es el destructivo,
 * y se separa con una línea de pelo en vez de pintarlo de rojo: el rojo es
 * para lo que le pasa al paciente, no para un botón de utilería. La distancia
 * evita el clic accidental mejor que el color.
 *
 * loop-core (:3001) todavía no existe, así que la ruta que se ejecuta hoy es
 * la de fallo. Tiene que verse igual de intencional que la de éxito: aviso
 * inline y flotante, sin excepción sin capturar y sin empujar el layout.
 */
export function DemoControls() {
  const router = useRouter();
  const [pending, setPending] = useState<ActionId | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), FEEDBACK_TTL_MS);
    return () => clearTimeout(timer);
  }, [feedback]);

  const run = useCallback(
    async (id: ActionId) => {
      setPending(id);
      setFeedback(null);

      // core-client nunca lanza: siempre resuelve con un DataResult.
      const result: DataResult<{ message: string }> =
        id === 'reset' ? await resetDemo() : await triggerDemoSpike(id);

      if (result.source === 'live') {
        setFeedback({ tone: 'ok', text: result.data.message });
        // El estado del paciente cambió en loop-core: volver a pedir los
        // datos del Server Component para que la página cuente lo mismo.
        router.refresh();
      } else {
        // Efecto (frase completa) + causa entre paréntesis. En ese orden la
        // frase empieza en mayúscula sin tener que capitalizar "loop-core" a
        // mano y estropear el nombre del servicio.
        setFeedback({
          tone: 'warn',
          text: `${result.data.message} (${describeReason(result.reason)})`,
        });
      }

      setPending(null);
    },
    [router],
  );

  return (
    <div className="relative flex shrink-0 items-center gap-1.5">
      {SPIKES.map((spike) => (
        <button
          key={spike.id}
          type="button"
          onClick={() => void run(spike.id)}
          disabled={pending !== null}
          aria-busy={pending === spike.id}
          // El estado pendiente se marca con el borde de acento del propio
          // .ghostbtn. Cambiar el texto a "Enviando…" ensanchaba el botón y
          // movía la barra entera en pleno demo.
          data-on={pending === spike.id}
          className="ghostbtn"
        >
          {spike.label}
        </button>
      ))}

      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-hair" />

      <button
        type="button"
        onClick={() => void run('reset')}
        disabled={pending !== null}
        aria-busy={pending === 'reset'}
        data-on={pending === 'reset'}
        className="ghostbtn"
      >
        Reiniciar
      </button>

      {/* Posición absoluta: el aviso no debe empujar la barra superior ni
          mover los paneles de abajo mientras alguien está mirando. */}
      <div
        aria-live="polite"
        className="pointer-events-none absolute right-0 top-full z-20 mt-2 flex justify-end"
      >
        {feedback ? (
          // Fondo casi opaco sobre el vidrio: el aviso flota encima del header
          // del paciente, y texto translúcido sobre texto translúcido es lo
          // que se ve roto en un proyector. Mismo negro que el tooltip del
          // baseline —eran dos semiopacos distintos, uno por componente.
          <p
            className="glass flex max-w-[22rem] items-start gap-2 rounded-tile px-3 py-2 text-2xs leading-snug text-ink-2"
            style={{ background: FLOATING_SURFACE }}
          >
            <span
              aria-hidden
              className="dot mt-[3px]"
              style={{ background: feedback.tone === 'ok' ? 'var(--ok)' : 'var(--warn)' }}
            />
            {feedback.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
