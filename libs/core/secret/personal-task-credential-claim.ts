/** Read-only personal dispatch proof. This never grants account or provider access. */
import { currentActor } from '../authn/actor-context.js';
import { parseActorRef } from '../contracts/actor.js';
import { parseNhiId } from '../contracts/nhi-id.js';
import {
  credentialExecutionIdentity,
  type PersonalCredentialClaim,
} from '../foundation/credential-binding.js';
import { inspectInstalledPersonalRuntime } from '../organization/personal-runtime-identity.js';
import { currentScopeEnvelope, getMintedEnvelope } from '../scope-envelope.js';
import { getWorkItem, listActiveWorkLeases } from '../workforce/work-coordination.js';

const denied = () => new Error('[CREDENTIAL_PERSONAL_CLAIM_DENIED] Personal task admission failed');

/** Re-read on every use: installation, attribution and a lease are separate required proofs. */
export function assertPersonalTaskCredentialClaim(workItemId: string): PersonalCredentialClaim {
  const envelope = currentScopeEnvelope();
  const identity = credentialExecutionIdentity();
  const actor = currentActor();
  if (
    !envelope ||
    getMintedEnvelope(envelope.mint_ref) !== envelope ||
    !envelope.identity.mission_id ||
    !envelope.identity.task_id ||
    envelope.identity.tenant_slug !== undefined ||
    envelope.identity.organization_id !== undefined ||
    identity.tenantSlug !== undefined ||
    !['personal', 'public'].includes(envelope.identity.tier) ||
    envelope.policy.write_tier !== envelope.identity.tier ||
    !actor ||
    actor.provenance !== 'claim' ||
    actor.actor.kind !== 'agent'
  )
    throw denied();
  const nhi = parseNhiId(actor.actor.id);
  if (!nhi || nhi.legacy || nhi.tenant_slug !== null || nhi.organization_id !== null)
    throw denied();
  const installed = inspectInstalledPersonalRuntime();
  if (
    !installed.ready ||
    !installed.agentActive ||
    installed.agentId !== actor.actor.id ||
    !parseActorRef({ kind: 'human', id: installed.ownerId }) ||
    (actor.actor.on_behalf_of !== undefined && actor.actor.on_behalf_of !== installed.ownerId)
  )
    throw denied();
  const item = getWorkItem(workItemId);
  // current_attempt_id names the run, whereas attempt_id names the ledger entry.
  const attempt = item?.attempts?.find((entry) => entry.run_id === item.current_attempt_id);
  const lease = listActiveWorkLeases().find((entry) => entry.lease_id === item?.lease_id);
  if (
    !item ||
    item.item_id !== workItemId ||
    item.status !== 'in_progress' ||
    !item.current_attempt_id ||
    !attempt ||
    attempt.status !== 'running' ||
    !lease ||
    lease.status !== 'active' ||
    !(Date.parse(lease.expires_at) > Date.now()) ||
    lease.item_id !== item.item_id ||
    attempt.lease_id !== lease.lease_id ||
    lease.holder_peer_id !== actor.actor.id ||
    item.claimed_by_peer_id !== actor.actor.id ||
    attempt.actor_peer_id !== actor.actor.id ||
    (lease.holder_user_id !== undefined && lease.holder_user_id !== installed.ownerId) ||
    (item.claimed_by_user_id !== undefined && item.claimed_by_user_id !== installed.ownerId) ||
    (attempt.actor_user_id !== undefined && attempt.actor_user_id !== installed.ownerId)
  )
    throw denied();
  for (const key of [
    'tenant_slug',
    'organization_id',
    'project_id',
    'mission_id',
    'task_id',
  ] as const) {
    if (
      envelope.identity[key] !== item.context?.[key] ||
      envelope.identity[key] !== actor.scope[key]
    )
      throw denied();
  }
  if (
    identity.missionId !== envelope.identity.mission_id ||
    identity.taskId !== envelope.identity.task_id ||
    actor.scope.tier !== envelope.identity.tier ||
    actor.scope.session_id !== envelope.identity.session_id ||
    (envelope.identity.nhi_id !== undefined && envelope.identity.nhi_id !== actor.actor.id) ||
    (actor.scope.nhi_id !== undefined && actor.scope.nhi_id !== actor.actor.id)
  )
    throw denied();
  return Object.freeze({
    ownerId: installed.ownerId,
    actorId: actor.actor.id,
    workItemId: item.item_id,
    attemptId: item.current_attempt_id,
    leaseId: lease.lease_id,
  });
}
