/**
 * GET /healthz — `HealthResponse` de `shared/contracts.ts`.
 *
 * Es lo primero que mira el runbook antes de salir al escenario: dice si el
 * servicio está en mock o en real, y qué opina de Stedi.
 */

import type { FastifyInstance } from 'fastify';

import { HealthResponse, type HealthResponse as HealthResponseType } from '@loop/shared';

import type { AppConfig } from '../config.js';
import { getStediUpstreamHealth } from '../stedi/client.js';

export const HEALTH_PATH = '/healthz';

export function registerHealthRoute(app: FastifyInstance, cfg: AppConfig): void {
  app.get(HEALTH_PATH, async (request, reply) => {
    const body: HealthResponseType = {
      service: 'loop-coverage',
      ok: true,
      useMocks: cfg.useMocks,
      uptimeSeconds: Math.round(process.uptime()),
      version: cfg.version,
      upstream: { stedi: getStediUpstreamHealth(cfg) },
    };

    // Mismo criterio que en /coverage/check: validamos lo nuestro antes de
    // enviarlo. Si /healthz miente, el runbook del demo miente.
    const validated = HealthResponse.safeParse(body);
    if (!validated.success) {
      request.log.error({ issues: validated.error.issues }, 'BUG: /healthz fuera de contrato');
      return reply.code(200).send(body);
    }

    return reply.code(200).send(validated.data);
  });
}
