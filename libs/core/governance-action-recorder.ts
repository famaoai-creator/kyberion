import { createLogger } from './logger.js';

export type GovernanceActionRecord = {
  agentId: string;
  operation: string;
  reason: string;
  policyViolation: boolean;
};

type GovernanceActionSink = (record: GovernanceActionRecord) => void;

const MAX_PENDING_RECORDS = 256;
const logger = createLogger('governance-action-recorder');
let sink: GovernanceActionSink | undefined;
const pending: GovernanceActionRecord[] = [];
let warnedAboutOverflow = false;

/**
 * Install the kill-switch sink without importing the kill-switch module here.
 * Low-level-only processes intentionally remain best-effort until this seam
 * is registered; they must load kill-switch when anomaly monitoring is needed.
 */
export function registerGovernanceActionSink(nextSink: GovernanceActionSink): void {
  sink = nextSink;
  while (pending.length > 0) {
    const record = pending.shift()!;
    sink(record);
  }
}

/** Record a governance action from low-level boundaries such as secure-io. */
export function recordGovernanceAction(
  agentId: string,
  operation: string,
  reason: string,
  policyViolation = false
): void {
  const record = { agentId, operation, reason, policyViolation };
  if (sink) {
    sink(record);
    return;
  }
  if (pending.length >= MAX_PENDING_RECORDS) {
    pending.shift();
    if (!warnedAboutOverflow) {
      warnedAboutOverflow = true;
      logger.warn(
        `Governance action sink is not registered; pending buffer reached ${MAX_PENDING_RECORDS} records and oldest records will be dropped.`
      );
    }
  }
  pending.push(record);
}
