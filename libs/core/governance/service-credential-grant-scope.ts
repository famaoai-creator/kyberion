import type { ApprovalRequestRecord } from './approval-store.js';
import { validateHumanFinalDecision } from './approval-human-decision.js';
import { assuranceOfAuthMethod } from './approval-assurance.js';

/** Allocation does not change the connection's owner or confer effect authority. */
export interface ServiceCredentialAllocationScope {
  binding_id: string;
  target: string;
  owner_ref: string;
  service_id: string;
  secret_refs: string[];
  allowed_actions: string[];
  project_id?: string;
  mission_id?: string;
  task_id?: string;
}

const fields = [
  'binding_id',
  'target',
  'owner_ref',
  'service_id',
  'secret_refs',
  'allowed_actions',
  'project_id',
  'mission_id',
  'task_id',
];
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const reference = /^[A-Z][A-Z0-9_]{0,127}$/;

export function normalizeServiceCredentialAllocation(
  value: ServiceCredentialAllocationScope
): ServiceCredentialAllocationScope {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new Error('invalid service_allocation fields');
  const text = (
    key:
      | 'target'
      | 'binding_id'
      | 'owner_ref'
      | 'service_id'
      | 'project_id'
      | 'mission_id'
      | 'task_id',
    pattern: RegExp
  ): string => {
    const raw = value[key];
    if (typeof raw !== 'string' || !pattern.test(raw.trim()))
      throw new Error(`invalid service_allocation.${key}`);
    return raw.trim();
  };
  const list = (key: 'secret_refs' | 'allowed_actions', pattern: RegExp): string[] => {
    const raw = value[key];
    if (
      !Array.isArray(raw) ||
      !raw.length ||
      raw.length > 64 ||
      raw.some((item) => typeof item !== 'string' || !pattern.test(item.trim()))
    )
      throw new Error(`invalid service_allocation.${key}`);
    return [...new Set(raw.map((item) => item.trim()))].sort();
  };
  return {
    binding_id: text('binding_id', identifier),
    target: text('target', /^[^\x00-\x1f\x7f]{1,2048}$/),
    owner_ref: text('owner_ref', /^user:[a-z][a-z0-9-]*$/),
    service_id: text('service_id', /^[a-z][a-z0-9-]{0,63}$/),
    secret_refs: list('secret_refs', reference),
    allowed_actions: list('allowed_actions', identifier),
    ...(value.project_id !== undefined ? { project_id: text('project_id', identifier) } : {}),
    ...(value.mission_id !== undefined ? { mission_id: text('mission_id', identifier) } : {}),
    ...(value.task_id !== undefined ? { task_id: text('task_id', identifier) } : {}),
  };
}

/** Re-read the authenticated decision, never trust a grant record's claimed grantor. */
export function serviceAllocationApprovedByOwner(
  approval: ApprovalRequestRecord,
  ownerRef: string
): boolean {
  const decision = approval.workflow?.approvals?.find(
    (entry) =>
      entry.status === 'approved' && entry.decidedByType === 'human' && entry.authenticated === true
  );
  if (
    !decision ||
    decision.approvedBy !== ownerRef ||
    !assuranceOfAuthMethod(decision.authMethod) ||
    approval.accountability?.finalDecision !== 'human_only'
  )
    return false;
  try {
    validateHumanFinalDecision({
      accountability: approval.accountability,
      decidedByType: decision.decidedByType,
      authenticated: decision.authenticated,
      authMethod: decision.authMethod,
      payloadHash: decision.payloadHash,
      effectBinding: decision.effectBinding,
      phase: 'recheck',
    });
    return true;
  } catch {
    return false;
  }
}
