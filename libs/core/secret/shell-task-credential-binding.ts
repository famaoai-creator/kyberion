import type { TaskCredentialBinding } from '../foundation/credential-binding.js';
import { credentialExecutionIdentity } from '../foundation/credential-binding.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { currentActor } from '../actor-context.js';
import { assertScopeContext, type ScopeContext } from '../scope-context-validation.js';
import { getWorkItem, listActiveWorkLeases } from '../workforce/work-coordination.js';
import { assertIsolatedProviderHome } from '../provider/provider-auth-home.js';

export const TASK_BINDING_SECRET_KEY = '__KYBERION_TASK_BINDING__';
type BindingInput = Readonly<{ scope: Readonly<ScopeContext>; workItemId: string }>;
const denied = () => new Error('[CREDENTIAL_BINDING_UNAVAILABLE] Task credential admission failed');
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function strings(value: unknown): Record<string, string> {
  if (!record(value) || Object.keys(value).length > 64) throw denied();
  const entries = Object.entries(value);
  for (const [key, entry] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
      ['__proto__', 'constructor', 'prototype'].includes(key) ||
      typeof entry !== 'string' ||
      !entry ||
      entry.length > 16_384 ||
      entry.includes(String.fromCharCode(0))
    )
      throw denied();
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Only the current canonical claim holder may ask the configured secret service. */
function admittedClaim(input: BindingInput): string {
  const scope = assertScopeContext(input.scope, { requireTenant: true, requireMission: true });
  const identity = credentialExecutionIdentity();
  const envelope = currentScopeEnvelope();
  const actor = currentActor();
  const item = getWorkItem(input.workItemId);
  // Work Coordination stores the current run_id in current_attempt_id; the
  // distinct attempt_id identifies the immutable attempt ledger entry.
  const attempt = item?.attempts?.find((entry) => entry.run_id === item.current_attempt_id);
  const lease = listActiveWorkLeases().find((entry) => entry.lease_id === item?.lease_id);
  if (
    !scope.task_id ||
    !envelope ||
    !actor ||
    actor.provenance !== 'claim' ||
    !item ||
    item.status !== 'in_progress' ||
    !attempt ||
    attempt.status !== 'running' ||
    !lease ||
    lease.item_id !== item.item_id ||
    attempt.lease_id !== lease.lease_id ||
    lease.holder_peer_id !== actor.actor.id ||
    item.claimed_by_peer_id !== actor.actor.id ||
    attempt.actor_peer_id !== actor.actor.id ||
    scope.tier !== envelope.policy.write_tier
  )
    throw denied();
  for (const [scopeKey, identityKey] of [
    ['tenant_slug', 'tenantSlug'],
    ['mission_id', 'missionId'],
    ['task_id', 'taskId'],
  ] as const) {
    const expected = scope[scopeKey];
    if (
      expected !== identity[identityKey] ||
      expected !== envelope.identity[scopeKey] ||
      expected !== item.context?.[scopeKey] ||
      expected !== actor.scope[scopeKey]
    )
      throw denied();
  }
  for (const key of ['organization_id', 'project_id'] as const) {
    if (
      scope[key] !== envelope.identity[key] ||
      scope[key] !== item.context?.[key] ||
      scope[key] !== actor.scope[key]
    )
      throw denied();
  }
  return JSON.stringify([item.item_id, item.lease_id, item.current_attempt_id, actor.actor.id]);
}

/**
 * Versioned response from an operator-configured resolver command. Identity is
 * always stamped from the current claim, never accepted from command output.
 */
export async function bindShellTaskCredentials(
  input: BindingInput,
  resolve: (request: Readonly<Record<string, unknown>>) => string | null
): Promise<TaskCredentialBinding | null> {
  const claim = admittedClaim(input);
  const raw = resolve(
    Object.freeze({ version: 1, scope: input.scope, workItemId: input.workItemId })
  );
  if (claim !== admittedClaim(input)) throw denied();
  if (raw === null) return null;
  if (Buffer.byteLength(raw, 'utf8') > 128 * 1024) throw denied();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw denied();
  }
  if (
    !record(value) ||
    value.version !== 1 ||
    Object.keys(value).some((key) => !['version', 'secrets', 'providerEnvironments'].includes(key))
  )
    throw denied();
  const secrets = strings(value.secrets);
  let providerEnvironments: Record<string, NodeJS.ProcessEnv> | undefined;
  if (value.providerEnvironments !== undefined) {
    if (!record(value.providerEnvironments) || Object.keys(value.providerEnvironments).length > 16)
      throw denied();
    providerEnvironments = {};
    for (const [provider, env] of Object.entries(value.providerEnvironments)) {
      if (
        !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(provider) ||
        ['constructor', 'prototype'].includes(provider)
      )
        throw denied();
      const configured = strings(env);
      assertIsolatedProviderHome(configured, input.scope.tenant_slug!);
      providerEnvironments[provider] = configured;
    }
  }
  return {
    tenantSlug: input.scope.tenant_slug!,
    missionId: input.scope.mission_id,
    taskId: input.scope.task_id,
    secrets,
    ...(providerEnvironments ? { providerEnvironments } : {}),
  };
}
