/**
 * Registro en memoria de las llamadas.
 *
 * En el demo hay UNA llamada activa a la vez, pero el store soporta varias sin
 * romperse (dos pestañas del navegador, un ensayo que se solapa con otro).
 *
 * Sin persistencia a proposito: si el proceso muere, la llamada murio con el.
 * El unico registro duradero es el `Encounter` que escribe loop-core al colgar.
 *
 * Limpieza: las sesiones terminadas hace mas de 30 minutos se descartan. Se
 * barre de forma perezosa en cada mutacion (el mapa tiene, como mucho, un
 * puñado de entradas) para no dejar un `setInterval` colgando del event loop.
 */

import type { PatientContext } from '../types.js';
import { CallSession, type CallSessionOptions } from './callSession.js';

/** Cuanto se conserva una llamada ya terminada. */
export const ENDED_RETENTION_MS = 30 * 60 * 1000;

export interface SessionStoreOptions {
  /** Retencion de sesiones terminadas. Default: 30 min. */
  retentionMs?: number;
  /** Reloj inyectable, tambien heredado por las sesiones que crea. */
  now?: () => Date;
}

export class SessionStore {
  private readonly sessions = new Map<string, CallSession>();
  private readonly retentionMs: number;
  private readonly clock: () => Date;

  constructor(options: SessionStoreOptions = {}) {
    this.retentionMs = options.retentionMs ?? ENDED_RETENTION_MS;
    this.clock = options.now ?? (() => new Date());
  }

  /** Crea y registra una llamada. El reloj del store se hereda si no se pasa otro. */
  create(patientId: string, ctx: PatientContext, opts: CallSessionOptions = {}): CallSession {
    this.sweep();
    const session = new CallSession(patientId, ctx, { now: this.clock, ...opts });
    this.sessions.set(session.callId, session);
    return session;
  }

  /** Registra una sesion ya construida (util para tests y para reanudaciones). */
  put(session: CallSession): CallSession {
    this.sessions.set(session.callId, session);
    return session;
  }

  /** Devuelve la sesion, o null. Nunca lanza. */
  get(callId: string): CallSession | null {
    return this.sessions.get(callId) ?? null;
  }

  /**
   * Cierra la llamada y la deja en el registro (todavia consultable durante
   * la ventana de retencion, para el write-back y el dashboard).
   */
  end(callId: string): CallSession | null {
    const session = this.sessions.get(callId) ?? null;
    if (session !== null) session.end();
    this.sweep();
    return session;
  }

  /** Llamadas vivas, en orden de creacion. */
  active(): CallSession[] {
    this.sweep();
    return [...this.sessions.values()].filter((session) => session.getState() !== 'ended');
  }

  /** La llamada viva mas reciente. El caso normal del demo. */
  current(): CallSession | null {
    const live = this.active();
    return live.length > 0 ? live[live.length - 1]! : null;
  }

  /** Todas las sesiones retenidas, vivas o no. */
  all(): CallSession[] {
    return [...this.sessions.values()];
  }

  /** Descarta las sesiones terminadas hace mas de `retentionMs`. */
  sweep(): number {
    const nowMs = this.clock().getTime();
    let removed = 0;
    for (const [callId, session] of this.sessions) {
      const endedAt = session.endedAt;
      if (endedAt === null) continue;
      const endedMs = Date.parse(endedAt);
      if (!Number.isFinite(endedMs)) continue;
      if (nowMs - endedMs > this.retentionMs) {
        this.sessions.delete(callId);
        removed += 1;
      }
    }
    return removed;
  }

  /** Vacia el registro. Solo para tests y para `POST /demo/reset`. */
  clear(): void {
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** Singleton del proceso. Es el que usan las rutas y el orquestador. */
export const sessionStore = new SessionStore();
