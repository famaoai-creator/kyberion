import { listWorkItems } from '../workforce/work-coordination.js';
import { resolveDotDelegationLimit, type DotCharter } from './dot-charter.js';
import { currentDotActions, dotProposalHash, type DotActionRecord } from './dot-action-ledger.js';
import {
  dotRecordAdmissionMatches,
  genericDotActionIdentity,
  withDotAdmissionLock,
} from './dot-admission-identity.js';
import type { DotDispatchDeps } from './dot-dispatch.js';

const OPEN_WORK_ITEM_STATUSES = ['backlog', 'ready', 'in_progress', 'blocked', 'review'] as const;
/** A parked approval already holds a slot; a capacity wait never does. */
export function dotDelegationCapacity(
  charter: DotCharter,
  deps: DotDispatchDeps = {}
): { cap: number; open: number; free: number } {
  const parked = currentDotActions(charter.dot_id, deps).filter(
    (row) => row.status === 'parked' || row.status === 'admitted'
  ).length;
  const count =
    deps.countOpenWorkItems ??
    ((dotId: string) =>
      listWorkItems(
        { status: [...OPEN_WORK_ITEM_STATUSES] },
        deps.rootDir ? { rootDir: deps.rootDir } : {}
      ).filter((item) => item.metadata?.dot_id === dotId).length);
  const cap = resolveDotDelegationLimit(charter.authority.max_concurrent_delegations);
  const open = count(charter.dot_id) + parked;
  return { cap, open, free: Math.max(0, cap - open) };
}

/** Validate saved immutable admission identities before the caller reruns all current gates. */
export function resumeDotCapacityActions(
  charter: DotCharter,
  deps: DotDispatchDeps,
  dispatch: (row: DotActionRecord) => DotActionRecord[]
): DotActionRecord[] {
  if (charter.status !== 'active') return [];
  return withDotAdmissionLock(charter, deps.rootDir, () => {
    const resumed: DotActionRecord[] = [];
    const pending = currentDotActions(charter.dot_id, deps)
      .filter((row) => row.status === 'waiting_capacity')
      .sort((left, right) => left.at.localeCompare(right.at));
    for (const row of pending) {
      if (dotDelegationCapacity(charter, deps).free === 0) break;
      // Front desk work resumes through its authenticated original caller.
      if (
        row.front_desk_execution ||
        !row.admission ||
        row.work_item_id ||
        row.request_id ||
        !dotRecordAdmissionMatches(charter, row) ||
        row.admission.authority_role !== charter.authority.authority_role
      )
        continue;
      const proposal = row.admission.proposal;
      const verified = genericDotActionIdentity(
        charter,
        proposal,
        row.admission.ordinal,
        row.admission.operation_key
      );
      if (
        verified.admission?.semantic_hash !== row.admission.semantic_hash ||
        dotProposalHash(charter.dot_id, proposal) !== row.proposal_hash
      )
        continue;
      resumed.push(...dispatch(row));
    }
    return resumed;
  });
}
