/**
 * ES-04: evidence class guard.
 *
 * A scenario run in the `simulated` execution profile proves wiring against
 * fixtures, never provider behaviour. Every intake that accepts provider /
 * release evidence calls `assertNotSimulatedEvidence` so a simulated report
 * cannot be registered as if it were real evidence.
 */

import type { ScenarioExecutionProfile } from './scenario-definition.js';

export type ScenarioEvidenceClass = ScenarioExecutionProfile;

export const SCENARIO_REPORT_SCHEMA_VERSION = 'kyberion-scenario-report.v1';

export class SimulatedEvidenceError extends Error {
  readonly code = 'SIMULATED_EVIDENCE_REJECTED';

  constructor(intake: string, detail: string) {
    super(
      `[SIMULATED_EVIDENCE_REJECTED] ${intake}: ${detail} — simulated scenario output is not provider evidence`
    );
    this.name = 'SimulatedEvidenceError';
  }
}

/** The evidence class a scenario report must carry for its execution profile. */
export function evidenceClassForProfile(profile: ScenarioExecutionProfile): ScenarioEvidenceClass {
  return profile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Why `value` counts as simulated evidence, or null when it does not. */
export function simulatedEvidenceReason(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (value.evidence_class === 'simulated') return 'evidence_class is "simulated"';
  const isScenarioReport = value.schema_version === SCENARIO_REPORT_SCHEMA_VERSION;
  const profile = value.executionProfile ?? value.execution_profile;
  if (profile === 'simulated') return 'executionProfile is "simulated"';
  if (isScenarioReport && value.evidence_class !== 'provider-qualified') {
    return 'scenario report without evidence_class "provider-qualified"';
  }
  return null;
}

export function assertNotSimulatedEvidence(value: unknown, intake: string): void {
  const reason = simulatedEvidenceReason(value);
  if (reason) throw new SimulatedEvidenceError(intake, reason);
}
