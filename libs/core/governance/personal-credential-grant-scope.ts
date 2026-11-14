/** Personal consent uses the canonical standing-grant store, never tenant allocation. */
import { parseNhiId } from '../contracts/nhi-id.js';
import { normalizeServiceCredentialAllocation } from './service-credential-grant-scope.js';
import type { GrantRecord } from './grant-store.js';

export const PERSONAL_CREDENTIAL_CAPABILITY = 'credential.personal_use';
export interface PersonalCredentialGrantScope {
  owner_ref: string;
  nhi_id: string;
  binding_id: string;
  service_id: string;
  target: string;
  secret_refs: string[];
  allowed_actions: string[];
  generation: string;
  project_id: string;
  mission_id: string;
  task_id: string;
}
export interface PersonalCredentialGrantDraft {
  scope: PersonalCredentialGrantScope;
  purpose: string;
  ttl_days: number;
}
export interface PersonalCredentialGrantRecord extends Omit<GrantRecord, 'scope' | 'capability'> {
  custody: { kind: 'person'; ref: string };
  capability: typeof PERSONAL_CREDENTIAL_CAPABILITY;
  scope: PersonalCredentialGrantScope;
}

export function normalizePersonalCredentialGrantScope(
  value: PersonalCredentialGrantScope
): PersonalCredentialGrantScope {
  const fields = [
    'owner_ref',
    'nhi_id',
    'binding_id',
    'service_id',
    'target',
    'secret_refs',
    'allowed_actions',
    'generation',
    'project_id',
    'mission_id',
    'task_id',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new Error('[PERSONAL_CREDENTIAL_GRANT_DENIED] Exact personal scope required');
  const { nhi_id, generation, ...allocation } = value;
  const nhi = typeof nhi_id === 'string' ? parseNhiId(nhi_id) : null;
  if (
    !nhi ||
    nhi.legacy ||
    nhi.tenant_slug !== null ||
    nhi.organization_id !== null ||
    typeof generation !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(generation)
  )
    throw new Error(
      '[PERSONAL_CREDENTIAL_GRANT_DENIED] Canonical personal NHI and generation required'
    );
  const normalized = normalizeServiceCredentialAllocation(allocation);
  if (!normalized.project_id || !normalized.mission_id || !normalized.task_id)
    throw new Error('[PERSONAL_CREDENTIAL_GRANT_DENIED] Exact work scope required');
  return {
    ...normalized,
    project_id: normalized.project_id,
    mission_id: normalized.mission_id,
    task_id: normalized.task_id,
    nhi_id,
    generation,
  };
}

export function personalCredentialGrantEffect(draft: PersonalCredentialGrantDraft): string {
  return `grant-standing:${PERSONAL_CREDENTIAL_CAPABILITY}:${draft.scope.owner_ref}:${draft.scope.binding_id}:${draft.scope.generation}`;
}
export function personalCredentialGrantPayload(
  draft: PersonalCredentialGrantDraft
): Record<string, unknown> {
  return {
    action: 'grant_standing',
    capability: PERSONAL_CREDENTIAL_CAPABILITY,
    custody: { kind: 'person', ref: draft.scope.owner_ref.slice(5) },
    scope: draft.scope,
    purpose: draft.purpose,
    ttl_days: draft.ttl_days,
    effect: personalCredentialGrantEffect(draft),
  };
}
