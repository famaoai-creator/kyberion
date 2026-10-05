/** Durable intake is a supervised step, never an HTTP-side detached promise. */
import { runFrontDeskExecutionIntake } from '@agent/core/surface/front-desk-execution';
import type { DotSupervisorStep } from './dot_supervisor_extensions.js';

export const FRONT_DESK_EXECUTION_SUPERVISOR_STEP: DotSupervisorStep = {
  id: 'front-desk-execution-intake',
  async run(now, active) {
    await runFrontDeskExecutionIntake(active, { now: () => now });
  },
};
