'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { DemoProfile } from '@loop/shared/contracts';

import { describeReason, resetDemo, triggerDemoSpike, type DataResult } from '@/lib/core-client';

type ActionId = DemoProfile | 'reset';

interface Feedback {
  tone: 'ok' | 'warn';
  text: string;
}

const BUTTONS: readonly { id: ActionId; label: string; accent: 'warn' | 'danger' | 'neutral' }[] = [
  { id: 'panic', label: 'Panic spike', accent: 'warn' },
  { id: 'cardiac-redflag', label: 'Cardiac red-flag', accent: 'danger' },
  { id: 'reset', label: 'Reset demo', accent: 'neutral' },
];

const ACCENT_CLASSES: Record<'warn' | 'danger' | 'neutral', string> = {
  warn: 'border-line-strong text-warn hover:tint-warn',
  danger: 'border-line-strong text-danger hover:tint-danger',
  neutral: 'border-line-strong text-ink-2 hover:bg-surface-2',
};

/** El mensaje se va solo: un aviso pegado en pantalla ensucia el siguiente plano. */
const FEEDBACK_TTL_MS = 6_000;

/**
 * Panel de control del demo — Contrato 6.
 *
 * Sin esto el demo en vivo es una ruleta: estos tres botones son los que
 * ponen al paciente en el estado que toca justo antes de cada bloque.
 *
 * loop-core (:3001) todavía no existe, así que la ruta que se ejecuta hoy es
 * la de fallo. Tiene que verse igual de intencional que la de éxito: mensaje
 * inline, sin excepción sin capturar y sin nada rojo en la consola.
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
    <div className="relative flex shrink-0 items-center gap-2">
      {BUTTONS.map((button) => (
        <button
          key={button.id}
          type="button"
          onClick={() => void run(button.id)}
          disabled={pending !== null}
          aria-busy={pending === button.id}
          className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${ACCENT_CLASSES[button.accent]}`}
        >
          {pending === button.id ? 'Enviando…' : button.label}
        </button>
      ))}

      {/* Posición absoluta: el aviso no debe empujar la barra superior ni
          mover los paneles de abajo mientras alguien está mirando. */}
      <div
        aria-live="polite"
        className="pointer-events-none absolute right-0 top-full z-20 mt-2 flex justify-end"
      >
        {feedback ? (
          // Fondo opaco, no translúcido: el aviso se solapa con el header del
          // paciente y un texto sobre otro texto se ve roto en el proyector.
          <p
            className="max-w-[30rem] rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-xs leading-snug text-ink shadow-xl"
            style={{ borderLeftWidth: '3px', borderLeftColor: feedback.tone === 'ok' ? 'var(--ok)' : 'var(--warn)' }}
          >
            {feedback.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
