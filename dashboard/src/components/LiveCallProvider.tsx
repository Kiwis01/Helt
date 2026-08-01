'use client';

/**
 * Estado compartido de la llamada en vivo — Contrato 5.
 *
 * Vive en un contexto y no dentro del panel porque tres componentes distintos
 * dependen del mismo stream: el panel pinta el transcript y la biometría, la
 * tarjeta de cobertura se rellena con `coverage.check`, y el gráfico de
 * outcomes se refresca con `episode.written`. Un solo `EventSource` para los
 * tres; abrir uno por componente multiplicaría las reconexiones.
 *
 * El proveedor no renderiza ningún nodo del DOM: envuelve celdas de una rejilla
 * y un `div` de más rompería el layout.
 *
 * Dos invariantes que sostienen el demo:
 *
 * 1. **Una desconexión nunca vacía la pantalla.** `EventSource` reconecta solo,
 *    y mientras tanto el estado se queda tal cual. Solo un `call.started` con un
 *    `callId` distinto limpia el transcript: es una llamada nueva, no la misma
 *    llamada reconectando.
 * 2. **Un evento inválido se descarta, no rompe.** Todo entra por
 *    `parseSseMessage`, se cuenta lo descartado y se enseña en el pie del panel.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';

import type {
  BiometricsTickEvent,
  CallEndedEvent,
  CoverageCheckEvent,
  EpisodeWrittenEvent,
  LiveEvent,
  SafetyEscalationEvent,
  TranscriptTurnEvent,
} from '@loop/shared/contracts';

import { config } from '@/lib/config';
import { DEMO_CALLS, demoStepEnvelope, type DemoCallId } from '@/lib/demo-call';
import { LIVE_EVENT_NAMES, parseLiveEnvelope, parseSseMessage } from '@/lib/live-events';

/* ================================================================== */
/* Estado                                                              */
/* ================================================================== */

export type ConnectionStatus =
  /** `NEXT_PUBLIC_USE_FIXTURES=true`: modo respaldo, ni se intenta la red. */
  | 'disabled'
  | 'connecting'
  | 'open'
  /** El stream se cayó o nunca abrió. `EventSource` sigue reintentando solo. */
  | 'retrying';

export interface LiveCallState {
  callId: string | null;
  startedAt: string | null;
  turns: readonly TranscriptTurnEvent[];
  biometrics: BiometricsTickEvent | null;
  /** El tick anterior, solo para calcular la tendencia (▲ ▼) sin guardar la serie entera. */
  previousBiometrics: BiometricsTickEvent | null;
  escalation: SafetyEscalationEvent | null;
  coverage: CoverageCheckEvent | null;
  ended: CallEndedEvent | null;
  written: EpisodeWrittenEvent | null;
  lastEventAt: string | null;
  received: number;
  /** Eventos que no cumplieron el contrato. Visible en el pie: un contador que sube es un bug de integración. */
  dropped: number;
}

const EMPTY_STATE: LiveCallState = {
  callId: null,
  startedAt: null,
  turns: [],
  biometrics: null,
  previousBiometrics: null,
  escalation: null,
  coverage: null,
  ended: null,
  written: null,
  lastEventAt: null,
  received: 0,
  dropped: 0,
};

/** Tope de burbujas en memoria. Una llamada larga no debe crecer sin límite. */
const MAX_TURNS = 300;

/** Espera antes del primer reintento, y techo al que llega creciendo. */
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 15_000;

type Action =
  | { type: 'event'; event: LiveEvent }
  | { type: 'dropped' }
  | { type: 'reset' };

function reduce(state: LiveCallState, action: Action): LiveCallState {
  if (action.type === 'reset') return EMPTY_STATE;
  if (action.type === 'dropped') return { ...state, dropped: state.dropped + 1 };

  const { event } = action;
  const base: LiveCallState = {
    ...state,
    received: state.received + 1,
    lastEventAt: event.data.at,
  };

  switch (event.event) {
    case 'call.started': {
      // Una reconexión puede repetir `call.started` de la MISMA llamada: en ese
      // caso no se toca nada, porque limpiar el transcript aquí sería
      // exactamente el fallo que este panel tiene prohibido tener.
      if (state.callId === event.data.callId) return base;
      return {
        ...EMPTY_STATE,
        callId: event.data.callId,
        startedAt: event.data.at,
        lastEventAt: event.data.at,
        received: base.received,
        dropped: state.dropped,
      };
    }

    case 'transcript.turn': {
      const turns = [...state.turns, event.data];
      return { ...base, turns: turns.length > MAX_TURNS ? turns.slice(-MAX_TURNS) : turns };
    }

    case 'biometrics.tick':
      return { ...base, previousBiometrics: state.biometrics, biometrics: event.data };

    case 'safety.escalation':
      return { ...base, escalation: event.data };

    case 'coverage.check':
      return { ...base, coverage: event.data };

    case 'call.ended':
      return { ...base, ended: event.data };

    case 'episode.written':
      return { ...base, written: event.data };

    default:
      return base;
  }
}

/* ================================================================== */
/* Contexto                                                            */
/* ================================================================== */

export interface LiveCallContextValue {
  state: LiveCallState;
  connection: ConnectionStatus;
  /** Guion en reproducción, o null. */
  replay: DemoCallId | null;
  startReplay: (id: DemoCallId) => void;
  stopReplay: () => void;
}

/**
 * Valor inerte por defecto. Un componente montado fuera del proveedor enseña el
 * estado vacío en vez de lanzar: esta pantalla se proyecta y ninguna
 * equivocación de montaje puede convertirse en un error boundary en directo.
 */
const INERT: LiveCallContextValue = {
  state: EMPTY_STATE,
  connection: 'disabled',
  replay: null,
  startReplay: () => {},
  stopReplay: () => {},
};

const LiveCallContext = createContext<LiveCallContextValue>(INERT);

export function useLiveCall(): LiveCallContextValue {
  return useContext(LiveCallContext);
}

/* ================================================================== */
/* Proveedor                                                           */
/* ================================================================== */

export const LIVE_STREAM_PATH = '/api/v1/live/stream';

export function LiveCallProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, dispatch] = useReducer(reduce, EMPTY_STATE);
  const [connection, setConnection] = useState<ConnectionStatus>(
    config.useFixtures ? 'disabled' : 'connecting',
  );
  const [replay, setReplay] = useState<DemoCallId | null>(null);
  const timers = useRef<number[]>([]);

  /* --- Stream de loop-voice --- */
  useEffect(() => {
    // Modo respaldo: el wifi está muerto o loop-voice no entra en este ensayo.
    // No se abre el stream para no dejar un EventSource reintentando en bucle.
    if (config.useFixtures) return;

    const url = `${config.voiceUrl}${LIVE_STREAM_PATH}`;
    let source: EventSource | null = null;
    let retry: number | undefined;
    let delay = RECONNECT_BASE_MS;
    let disposed = false;

    const connect = (): void => {
      if (disposed) return;

      const current = new EventSource(url);
      source = current;

      for (const name of LIVE_EVENT_NAMES) {
        current.addEventListener(name, (message: Event) => {
          const raw: unknown = message instanceof MessageEvent ? message.data : undefined;
          const event = parseSseMessage(name, raw);
          dispatch(event ? { type: 'event', event } : { type: 'dropped' });
        });
      }

      current.addEventListener('open', () => {
        delay = RECONNECT_BASE_MS;
        setConnection('open');
      });

      current.addEventListener('error', () => {
        // La reconexión se lleva a mano en vez de dejársela a `EventSource`.
        // Cuando el puerto 3002 está cerrado —que es el estado normal hasta que
        // Lewis levanta loop-voice— el navegador reintenta cada pocos
        // milisegundos, y ese bucle satura el hilo principal: la página se
        // queda pintada pero deja de responder a los clics. Cerrando el stream
        // y reprogramando con espera creciente, "esperando a loop-voice" es un
        // estado barato en vez de una fuga.
        current.close();
        if (disposed) return;
        setConnection('retrying');
        retry = window.setTimeout(connect, delay);
        delay = Math.min(Math.round(delay * 1.6), RECONNECT_MAX_MS);
      });
    };

    connect();

    return () => {
      disposed = true;
      window.clearTimeout(retry);
      source?.close();
    };
  }, []);

  /* --- Refresco de los gráficos al escribirse el episodio --- */
  const writtenId = state.written?.encounterId ?? null;
  useEffect(() => {
    if (!writtenId) return;
    // Vuelve a ejecutar el Server Component: outcomes y episodios se repintan
    // con el episodio recién escrito. Es el cierre visual del pitch.
    router.refresh();
  }, [writtenId, router]);

  /* --- Modo replay --- */
  const clearTimers = useCallback((): void => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  }, []);

  const stopReplay = useCallback((): void => {
    clearTimers();
    setReplay(null);
  }, [clearTimers]);

  const startReplay = useCallback(
    (id: DemoCallId): void => {
      clearTimers();
      dispatch({ type: 'reset' });
      setReplay(id);

      const call = DEMO_CALLS[id];
      let last = 0;

      for (const step of call.steps) {
        last = Math.max(last, step.atMs);
        timers.current.push(
          window.setTimeout(() => {
            // Misma puerta de validación que el SSE: si el guion se desviara del
            // contrato, se ve aquí y no delante de los jueces.
            const event = parseLiveEnvelope(demoStepEnvelope(step, new Date().toISOString()));
            dispatch(event ? { type: 'event', event } : { type: 'dropped' });
          }, step.atMs),
        );
      }

      // El estado de la llamada se queda en pantalla; lo que termina es el
      // indicador de "reproduciendo".
      timers.current.push(window.setTimeout(() => setReplay(null), last + 800));
    },
    [clearTimers],
  );

  useEffect(() => clearTimers, [clearTimers]);

  const value = useMemo<LiveCallContextValue>(
    () => ({ state, connection, replay, startReplay, stopReplay }),
    [state, connection, replay, startReplay, stopReplay],
  );

  return <LiveCallContext.Provider value={value}>{children}</LiveCallContext.Provider>;
}
