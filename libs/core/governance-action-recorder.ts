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
let droppedRecords = 0;
const reportedSinkFailureClasses = new Set<string>();

/** Group sink failures so the same fault is only reported once per process. */
function classifySinkFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.name || 'Error';
  }
  return typeof error;
}

/**
 * Deliver one record without ever throwing into the caller. This recorder is
 * reached from policy-denial paths (secure-io), so a faulty sink must not turn
 * an audit write into a failure of the operation being audited.
 */
function deliver(record: GovernanceActionRecord, target: GovernanceActionSink): void {
  try {
    target(record);
  } catch (error) {
    const failureClass = classifySinkFailure(error);
    if (!reportedSinkFailureClasses.has(failureClass)) {
      reportedSinkFailureClasses.add(failureClass);
      logger.error(
        `Governance action sink threw ${failureClass}; the record was discarded and further ${failureClass} failures will be suppressed.`,
        { message: error instanceof Error ? error.message : String(error) }
      );
    }
  }
}

/**
 * Install the kill-switch sink without importing the kill-switch module here.
 * Low-level-only processes intentionally remain best-effort until this seam
 * is registered; they must load kill-switch when anomaly monitoring is needed.
 */
export function registerGovernanceActionSink(nextSink: GovernanceActionSink): void {
  sink = nextSink;
  const drained = pending.length;
  while (pending.length > 0) {
    const record = pending.shift()!;
    deliver(record, nextSink);
  }
  if (drained > 0 || droppedRecords > 0) {
    logger.warn(
      `Governance action sink registered; drained ${drained} buffered record(s) and ${droppedRecords} record(s) were dropped before registration.`,
      { drained, dropped: droppedRecords }
    );
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
    deliver(record, sink);
    return;
  }
  if (pending.length >= MAX_PENDING_RECORDS) {
    pending.shift();
    droppedRecords += 1;
    if (!warnedAboutOverflow) {
      warnedAboutOverflow = true;
      logger.warn(
        `Governance action sink is not registered; pending buffer reached ${MAX_PENDING_RECORDS} records and oldest records are being dropped (${droppedRecords} dropped so far; the total is reported when a sink is registered).`,
        { dropped: droppedRecords, capacity: MAX_PENDING_RECORDS }
      );
    }
  }
  pending.push(record);
}
