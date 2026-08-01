/**
 * @loop/shared — punto de entrada.
 *
 * Los cuatro servicios importan desde aquí:
 *
 *   import { PatientContext, CoverageCheckResponse } from '@loop/shared';
 *   import { PORTS, LOOP_PATIENT_ID } from '@loop/shared';
 *
 * Los fixtures se importan por subruta:
 *
 *   import happy from '@loop/shared/fixtures/context.happy.json';
 */

export * from './contracts.js';
export * from './constants.js';
