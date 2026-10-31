import type { DotDispatchDeps, DotBoundsVerdict } from './dot-dispatch.js';
import type { DotCharter } from './dot-charter.js';
import type { DotProposal } from './dot-proposals.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import type { AutonomousOpsGateResult } from '../governance/autonomous-ops-gate.js';
import { currentDotActions, type DotActionRecord } from './dot-action-ledger.js';
import { dotAdmissionScopeHash, withDotAdmissionLock } from './dot-admission-identity.js';
import { recoveryEvidenceHash } from '../surface/front-desk-recovery-receipt.js';
import {
  AUTONOMY_APPROVAL_CHANNEL,
  resolveInterventionLevel,
} from '../governance/approval-decision-card.js';
import { loadApprovalRequest } from '../governance/approval-store.js';
import { approvalUsabilityRefusal } from '../governance/approval-linked-usability.js';
import { isOperationsHalted } from '../governance/operations-halt.js';
import {
  requireCurrentDotJudgmentApproval,
  recordDeferredDotJudgmentApprovalFeedback,
} from './dot-judgment-approval.js';
const DECISION_RANK = { auto: 0, notify: 1, approve: 2 };
export interface AdmissionRecoveryPorts {
  find: (ref: string) => WorkItem | undefined;
  scope: (proposal: DotProposal) => DotBoundsVerdict;
  preGate: (proposal: DotProposal) => { ok: boolean | 'escalate' };
  gate: (proposal: DotProposal) => AutonomousOpsGateResult;
  shadow: (proposal: DotProposal, actionRef: string, gate: AutonomousOpsGateResult) => boolean;
  execute: (record: DotActionRecord) => DotActionRecord;
}
/** Admission recovery never executes effects or reopens an existing WorkItem. */
export function reconcileAdmittedDotAction(
  charter: DotCharter,
  record: DotActionRecord,
  deps: DotDispatchDeps,
  ports: AdmissionRecoveryPorts
): DotActionRecord {
  return withDotAdmissionLock(charter, deps.rootDir, () => {
    const latest = currentDotActions(charter.dot_id, deps).find(
      (row) => row.action_ref === record.action_ref
    );
    if (!latest || latest.status !== 'admitted') return latest ?? record;
    const identity = latest.admission;
    if (
      !identity ||
      identity.scope_hash !== dotAdmissionScopeHash(charter) ||
      identity.authority_role !== charter.authority.authority_role ||
      recoveryEvidenceHash(identity.proposal) !== identity.semantic_hash
    )
      return latest;
    try {
      requireCurrentDotJudgmentApproval(charter, latest, deps);
    } catch {
      return latest;
    }
    const existing = ports.find(latest.action_ref);
    if (!existing) {
      const scope = ports.scope(identity.proposal);
      if (!scope.ok || charter.status !== 'active' || isOperationsHalted()) return latest;
      const preGate = ports.preGate(identity.proposal);
      if (preGate.ok !== true) return latest;
      const gate = ports.gate(identity.proposal);
      if (
        (!gate.allowed && gate.decision !== 'approve') ||
        !Number.isFinite(gate.score) ||
        gate.shadow ||
        DECISION_RANK[gate.decision] > DECISION_RANK[latest.decision ?? 'auto']
      )
        return latest;
      if (ports.shadow(identity.proposal, latest.action_ref, gate)) return latest;
      if (latest.request_id) {
        const approval = (
          deps.loadApproval ?? ((id: string) => loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, id))
        )(latest.request_id);
        if (
          !approval ||
          !['approved', 'applied'].includes(approval.status) ||
          approvalUsabilityRefusal(approval, 'dot_dispatch')
        )
          return latest;
      } else if (!['none', 'fyi'].includes(resolveInterventionLevel(gate))) return latest;
    }
    const result = ports.execute(latest);
    recordDeferredDotJudgmentApprovalFeedback(charter, latest, result, deps);
    return result;
  });
}
