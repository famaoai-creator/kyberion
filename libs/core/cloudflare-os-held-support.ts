import type { HeldActionRecord, HeldActionSummary } from './cloudflare-os-control-plane.js';

/** Replace simulated (provisional) references in held params with the applied results. */
export function resolveProvisionalReferences(value: unknown, refs: Map<string, unknown>): unknown {
  if (typeof value === 'string') {
    let resolved = value;
    for (const [provisional, actual] of refs) {
      if (resolved === provisional) return actual;
      resolved = resolved.replaceAll(provisional, String(actual));
    }
    return resolved;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveProvisionalReferences(entry, refs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        resolveProvisionalReferences(entry, refs),
      ])
    );
  }
  return value;
}

export function summarizeHeldAction(record: HeldActionRecord): HeldActionSummary {
  return {
    id: record.id,
    missionId: record.missionId,
    taskId: record.taskId,
    tenantSlug: record.tenantSlug,
    submittedBy: record.submittedBy,
    op: record.op,
    status: record.status,
    submittedAt: record.submittedAt,
    decidedAt: record.decidedAt,
    resolvedBy: record.resolvedBy,
    autoApproved: record.autoApproved,
    appliedAt: record.appliedAt,
    failureRecorded: Boolean(record.applyError),
    effectBinding: record.effectBinding,
    payloadHash: record.payloadHash,
    dependsOn: [...record.dependsOn],
    actionTag: record.actionTag,
    irreversible: record.irreversible,
    simulatable: Boolean(record.simulation || record.simulatable),
    provisionalRefs: [...(record.simulation?.provisionalRefs || [])],
    approvalRequestId: record.approvalRequest?.requestId,
    applyClaim: record.applyClaim,
  };
}
