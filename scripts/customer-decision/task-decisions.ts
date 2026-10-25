/**
 * CD-09 "Direct CLI work": `customer-decision task-decisions --tenant <t>
 * --mission <M> --task <id> [--json]` — the confirmed customer decisions a
 * task held on its own `requires_customer` questions, for an agent or
 * operator doing that task by hand (no worker dispatch, so no prompt section
 * carries them). Part of scripts/customer_decision.ts (the entry point).
 *
 * Read-only: it takes no case lock, reconciles nothing and writes no store.
 * The values are printed to stdout only (same rule as the dispatch prompt:
 * `resolvedTaskProposalDecisions` and `unconfirmedTaskProposals`, the pin's
 * own functions); the audit record carries ids and counts only.
 *
 * Refused unless the process is bound to the tenant (`KYBERION_TENANT` ==
 * `--tenant`) and the tenant is registered and active (CD-09 human decision
 * 2026-10-26). A mission of another tenant resolves to no case: nothing.
 */
import { resolveIdentityContext } from '@agent/core/authority';
import { readLedger } from '@agent/core/decision-ledger';
import { isActiveCustomerTenant } from '@agent/core/customer-channel-binding';
import {
  listAgendas,
  missionTaskConsumerId,
  readConsumedDecisionLock,
  resolvedTaskProposalDecisions,
  taskProposalsOf,
  unconfirmedTaskProposals,
} from '@agent/core/customer-decision';
import { resolveMissionDecisionCase } from '@agent/core/mission/mission-decision-lock';
import { ScriptExitError } from '../lib/harness.js';
import { isApprovedSupersededConsumerLock } from './superseded-locks.js';
import {
  type CustomerDecisionIo,
  asLedgerWriter,
  audit,
  diagnosticCode,
  requireOpt,
  tenantOf,
  usageError,
} from './common.js';

const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/u;

/** The tenant this process is bound to and may read: refused otherwise (exit 2). */
function boundActiveTenant(opts: Record<string, string>): string {
  const tenant = tenantOf(opts);
  if (opts.dir !== undefined) throw usageError('--dir is not accepted by task-decisions');
  const bound = resolveIdentityContext().tenantSlug?.trim();
  if (bound !== tenant) {
    throw new ScriptExitError(
      2,
      `[CUSTOMER_DECISION_TENANT_UNBOUND] task-decisions reads confidential decision values: run it bound to the tenant (KYBERION_TENANT=${tenant})`
    );
  }
  if (!isActiveCustomerTenant(tenant)) {
    throw new ScriptExitError(
      2,
      `[CUSTOMER_DECISION_TENANT_INACTIVE] tenant ${tenant} is not a registered, active tenant`
    );
  }
  return tenant;
}

export function runTaskDecisions(
  opts: Record<string, string>,
  io: CustomerDecisionIo,
  now: string
): unknown {
  const tenant = boundActiveTenant(opts);
  const missionId = requireOpt(opts, 'mission').toUpperCase();
  const taskId = requireOpt(opts, 'task');
  if (!MISSION_ID.test(missionId)) throw usageError('--mission must be a mission id');
  if (taskId.length > 200) throw usageError('--task must be a task id');
  const consumer = missionTaskConsumerId(missionId, taskId);
  const nothing = {
    tenant_slug: tenant,
    mission_id: missionId,
    task_id: taskId,
    consumer,
    case_found: false,
    decisions: [],
    unconfirmed: [],
  };
  let resolved: { tenantSlug: string; caseId: string } | null;
  try {
    resolved = io.missionCase
      ? io.missionCase(missionId)
      : resolveMissionDecisionCase(missionId, { tenantSlug: tenant });
  } catch (error) {
    // Another tenant's mission is not this tenant's to read: nothing.
    if (diagnosticCode(error) === 'MISSION_STATE_TENANT_MISMATCH') resolved = null;
    else throw error;
  }
  if (!resolved || resolved.tenantSlug !== tenant) {
    audit(tenant, 'task_decisions_read', {
      mission_id: missionId,
      task_id: taskId,
      consumer,
      case_found: false,
      count: 0,
    });
    return nothing;
  }
  const location = { tenantSlug: tenant, caseId: resolved.caseId };
  const { lock, agendas, ledger } = asLedgerWriter(tenant, () => ({
    lock: readConsumedDecisionLock(location, consumer),
    agendas: listAgendas(location),
    ledger: readLedger(location),
  }));
  // The pin's own view of the lock: its proposals and how far the task got.
  const judged = lock
    ? {
        decisions: taskProposalsOf(lock),
        status: lock.status,
        ...(lock.completed_at ? { completed_at: lock.completed_at } : {}),
      }
    : { decisions: [] };
  // A superseded mark counts only when the mission side verified its approval.
  const superseded =
    lock && isApprovedSupersededConsumerLock(tenant, lock) ? lock.superseded : undefined;
  const decisions =
    lock && !superseded ? resolvedTaskProposalDecisions(judged, agendas, ledger, now) : [];
  const unconfirmed =
    lock && !superseded ? unconfirmedTaskProposals(judged, agendas, ledger, now) : [];
  audit(tenant, 'task_decisions_read', {
    mission_id: missionId,
    task_id: taskId,
    consumer,
    case_id: resolved.caseId,
    case_found: true,
    lock_found: Boolean(lock),
    count: decisions.length,
    decision_ids: decisions.map((decision) => decision.decision_id),
    unconfirmed_proposal_ids: unconfirmed.map((item) => item.proposal_id),
    ...(superseded ? { superseded: true } : {}),
  });
  return {
    ...nothing,
    case_found: true,
    case_id: resolved.caseId,
    lock_found: Boolean(lock),
    ...(superseded ? { superseded: { by_task_id: superseded.by_task_id } } : {}),
    decisions,
    unconfirmed,
  };
}
