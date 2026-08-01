'use client';

/**
 * Alta de paciente — diálogo.
 *
 * El único punto de toda la vista clínica donde se ESCRIBE en Medplum, y por eso
 * se comporta al revés que el resto de la pantalla: aquí no hay degradación
 * elegante posible. Si el alta falla, el diálogo se queda abierto, con lo
 * escrito intacto y el motivo delante. Cerrar y decir "listo" sería mentir.
 *
 * El formulario no hace `fetch`: postea a un Server Action. El secreto de
 * Medplum no viaja ni existe en el bundle del navegador.
 *
 * Tres estados y ni uno más —vacío, error, creado— y los tres se ven
 * intencionales, que es requisito de esta pantalla: se proyecta delante de un
 * jurado y un formulario a medio pintar se lee como una app rota.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { createPatientAction } from '@/app/actions/patients';
import {
  GENDERS,
  IDLE_STATE,
  LANGUAGES,
  valuesOf,
  type NewPatientField,
  type NewPatientState,
} from '@/lib/chart/new-patient';

interface NewPatientDialogProps {
  /**
   * `false` cuando faltan credenciales de Medplum. El disparador se deshabilita
   * en vez de abrir un formulario que no puede terminar en nada.
   */
  canWrite: boolean;
  /**
   * La agenda se está pintando desde el respaldo local. No impide intentarlo
   * —el fallo de lectura puede ser un parpadeo— pero se avisa antes de teclear
   * una ficha entera.
   */
  usingFallback: boolean;
  label?: string;
}

export function NewPatientDialog({ canWrite, usingFallback, label = 'New patient' }: NewPatientDialogProps) {
  const [open, setOpen] = useState(false);
  // Remontar el formulario es lo que lo limpia: el estado de `useActionState`
  // vive dentro de él, así que una llave nueva es un formulario nuevo de verdad.
  const [attempt, setAttempt] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  function close() {
    setOpen(false);
    // Devolver el foco a donde estaba es lo que evita que quien navega con
    // teclado acabe al principio de la página tras cerrar.
    triggerRef.current?.focus();
  }

  function openFresh() {
    setAttempt((n) => n + 1);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
    // Solo depende de `open`: `close` únicamente toca un setState y un ref, así
    // que incluirlo recrearía el listener en cada render sin cambiar nada.
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="ghostbtn"
        onClick={openFresh}
        disabled={!canWrite}
        title={
          canWrite
            ? 'Add a patient to Medplum'
            : 'Medplum is not configured: without credentials no patient can be added'
        }
      >
        + {label}
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-6 py-10 backdrop-blur-sm"
          // Cierre al pinchar fuera. Se compara el objetivo con el propio fondo
          // para que un clic que empieza dentro del panel y termina en el borde
          // no cierre el formulario a medio rellenar.
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="glass bloom w-full max-w-[560px] rounded-card p-6"
          >
            <div className="flex items-start justify-between gap-4 pb-1">
              <div>
                <h2 id={titleId} className="text-lg font-semibold tracking-tight">
                  New patient
                </h2>
                <p className="pt-0.5 text-2xs text-ink-3">
                  Creates a Patient resource in Medplum. Shows up on the schedule right away.
                </p>
              </div>
              <button type="button" className="ghostbtn" onClick={close} aria-label="Close">
                Esc
              </button>
            </div>

            <NewPatientForm
              key={attempt}
              usingFallback={usingFallback}
              onClose={close}
              onRestart={openFresh}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ================================================================== */
/* Formulario                                                          */
/* ================================================================== */

function NewPatientForm({
  usingFallback,
  onClose,
  onRestart,
}: {
  usingFallback: boolean;
  onClose: () => void;
  onRestart: () => void;
}) {
  const [state, formAction] = useActionState<NewPatientState, FormData>(
    createPatientAction,
    IDLE_STATE,
  );
  const router = useRouter();

  // La acción ya llama a `revalidatePath('/')`; esto refresca además el árbol
  // que este navegador tiene en memoria, para que la fila nueva aparezca detrás
  // del diálogo sin que nadie recargue a mano delante del jurado.
  useEffect(() => {
    if (state.status === 'created') router.refresh();
  }, [state, router]);

  if (state.status === 'created') {
    return <CreatedView state={state} onClose={onClose} onRestart={onRestart} />;
  }

  const fieldErrors = state.status === 'invalid' ? state.fieldErrors : {};
  // React reinicia el formulario en cuanto termina su acción de servidor, así
  // que estos `defaultValue` son lo ÚNICO que evita que un error en un campo
  // borre los otros seis. Vienen del propio estado, no de un ref del cliente.
  const values = valuesOf(state);

  return (
    <form action={formAction} className="flex flex-col gap-3 pt-4" noValidate>
      {usingFallback ? (
        <p className="tile rounded-tile px-3.5 py-2.5 text-2xs leading-relaxed text-ink-2">
          The schedule is rendering from the local fallback. The patient is still written to Medplum
          for real; if it does not respond, you will see it here.
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Field
          name="given"
          label="First name"
          placeholder="María José"
          autoComplete="off"
          autoFocus
          required
          error={fieldErrors.given}
          defaultValue={values.given}
        />
        <Field
          name="family"
          label="Last name"
          placeholder="Ramírez"
          autoComplete="off"
          required
          error={fieldErrors.family}
          defaultValue={values.family}
        />

        <Field
          name="birthDate"
          label="Date of birth"
          type="date"
          error={fieldErrors.birthDate}
          defaultValue={values.birthDate}
        />

        <SelectField
          name="gender"
          label="Sex"
          defaultValue={values.gender}
          options={GENDERS}
          error={fieldErrors.gender}
        />

        <Field
          name="phone"
          label="Phone"
          type="tel"
          placeholder="+1 415 555 0134"
          autoComplete="off"
          error={fieldErrors.phone}
          defaultValue={values.phone}
          hint="The number Loop calls"
        />

        <SelectField
          name="language"
          label="Preferred language"
          defaultValue={values.language}
          options={LANGUAGES}
          error={fieldErrors.language}
          hint="The one the agent speaks"
        />

        <div className="col-span-2">
          <Field
            name="identifier"
            label="Identifier"
            placeholder="teachback-maria"
            autoComplete="off"
            error={fieldErrors.identifier}
            defaultValue={values.identifier}
            hint="Optional · this is the MRN shown on the schedule"
          />
        </div>
      </div>

      {state.status === 'failed' ? (
        <p
          className="rounded-tile px-3.5 py-2.5 text-xs leading-relaxed text-danger"
          style={{ background: 'var(--danger-soft)', border: '1px solid var(--danger-line)' }}
          role="alert"
          title={state.detail ?? undefined}
        >
          {state.message}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" className="ghostbtn" onClick={onClose}>
          Cancel
        </button>
        <SubmitButton />
      </div>
    </form>
  );
}

/**
 * El botón de envío vive aparte porque `useFormStatus` solo funciona dentro de
 * un componente hijo del `<form>`, no en el que lo declara.
 */
function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" className="ghostbtn" data-on="true" disabled={pending}>
      {pending ? 'Saving to Medplum…' : 'Create patient'}
    </button>
  );
}

/* ================================================================== */
/* Confirmación                                                        */
/* ================================================================== */

function CreatedView({
  state,
  onClose,
  onRestart,
}: {
  state: Extract<NewPatientState, { status: 'created' }>;
  onClose: () => void;
  onRestart: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 pt-4">
      <div className="tile rounded-tile px-4 py-4">
        <div className="flex items-center gap-2">
          <span className="pill pill-ok">
            <span className="dot dot-live" aria-hidden />
            Saved to Medplum
          </span>
        </div>
        <p className="pt-3 text-lg font-semibold leading-tight">{state.displayName}</p>
        {/* El id es lo que permite verificar el alta contra Medplum sin creerse
            esta pantalla. Se enseña entero, no truncado. */}
        <p className="select-all break-all pt-1 font-mono text-2xs text-ink-3">
          Patient/{state.id}
        </p>
      </div>

      <div className="flex items-center justify-end gap-2">
        <button type="button" className="ghostbtn" onClick={onRestart}>
          Create another
        </button>
        <button type="button" className="ghostbtn" onClick={onClose}>
          Back to schedule
        </button>
        <Link href={`/paciente/${state.id}`} className="ghostbtn" data-on="true">
          Open chart
        </Link>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Campos                                                              */
/* ================================================================== */

interface FieldProps {
  name: NewPatientField;
  label: string;
  error?: string;
  hint?: string;
  type?: 'text' | 'date' | 'tel';
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  autoFocus?: boolean;
  autoComplete?: string;
}

function Field({ name, label, error, hint, type = 'text', ...rest }: FieldProps) {
  const id = useId();
  const messageId = `${id}-msg`;

  return (
    <div className="min-w-0">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        className="field"
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error || hint ? messageId : undefined}
        {...rest}
      />
      <FieldMessage id={messageId} error={error} hint={hint} />
    </div>
  );
}

function SelectField({
  name,
  label,
  options,
  defaultValue,
  error,
  hint,
}: {
  name: NewPatientField;
  label: string;
  options: readonly { readonly code: string; readonly label: string }[];
  defaultValue: string;
  error?: string;
  hint?: string;
}) {
  const id = useId();
  const messageId = `${id}-msg`;

  return (
    <div className="min-w-0">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        name={name}
        className="field"
        // `key` con el valor, y no solo `defaultValue`: React aplica el
        // `defaultValue` de un <select> SOLO al montarlo — a diferencia de un
        // <input>, donde sí actualiza el atributo en cada render. Sin esto, un
        // error de validación en otro campo devolvía el género al valor inicial
        // y el alta se guardaba con un dato que el usuario ya había corregido.
        // Cambiar la llave lo remonta, que es la única forma de resembrarlo.
        key={defaultValue}
        defaultValue={defaultValue}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error || hint ? messageId : undefined}
      >
        {options.map((option) => (
          <option key={option.code} value={option.code}>
            {option.label}
          </option>
        ))}
      </select>
      <FieldMessage id={messageId} error={error} hint={hint} />
    </div>
  );
}

/**
 * El error PISA a la pista, no se apila debajo.
 *
 * Reservar la línea siempre —aunque esté vacía— evita que la rejilla salte
 * cuando aparece un error, que es cómo se pierde de vista el campo que hay que
 * corregir justo al ir a corregirlo.
 */
function FieldMessage({ id, error, hint }: { id: string; error?: string; hint?: string }) {
  return (
    <p id={id} className={`min-h-4 pt-1 text-2xs ${error ? 'text-danger' : 'text-ink-3'}`}>
      {error ?? hint ?? ''}
    </p>
  );
}
