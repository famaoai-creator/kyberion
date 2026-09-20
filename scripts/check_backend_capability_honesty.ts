import {
  buildBackendCapabilityHonestyReport,
  formatBackendCapabilityHonestyReport,
} from '@agent/core/backend-capability-honesty';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

/**
 * TC-17: hold the backend capability table to the same standard as the agent
 * pool.
 *
 * `utility_fit` decides whether a backend may be trusted to judge work, and
 * every CLI and API backend claims it by default argument. This fails when a
 * claim is contradicted by a recorded fitness probe, or when the governed
 * policy allows a mode that no profile describes, and prints the unproven
 * claims either way so the untested surface stays visible.
 */
export const runCheckBackendCapabilityHonesty = defineScript({
  name: 'check:backend-capability-honesty',
  flags: [],
  run(context) {
    const report = buildBackendCapabilityHonestyReport();
    context.print(formatBackendCapabilityHonestyReport(report));
    if (report.violations.length > 0) {
      throw new ScriptExitError(
        1,
        [
          'FAILED',
          ...report.violations.map(
            (violation) => `- [${violation.kind}] ${violation.mode}: ${violation.detail}`
          ),
        ].join('\n')
      );
    }
    context.print('[check:backend-capability-honesty] OK');
    return { report };
  },
});

if (
  isDirectScript(import.meta.url, 'check_backend_capability_honesty.ts') ||
  isDirectScript(import.meta.url, 'check_backend_capability_honesty.js')
)
  void runCheckBackendCapabilityHonesty();
