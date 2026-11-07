import { getSecretResolver } from './secret-resolver.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import {
  credentialExecutionIdentity,
  hasTaskCredentialBinding,
  withTaskCredentialBinding,
  type TaskCredentialBinding,
} from '../foundation/credential-binding.js';
import { assertScopeContext, type ScopeContext } from '../foundation/scope-context-validation.js';

/**
 * Attests claimed-task lineage while granting zero credentials. Fresh tenants
 * without a configured bindTask resolver still execute dispatched WorkItems
 * inside a binding, so credential-free work completes and credential
 * consumption keeps failing closed at point of use.
 */
function mintLineageBinding(identity: ReturnType<typeof credentialExecutionIdentity>) {
  const binding: TaskCredentialBinding = {
    tenantSlug: identity.tenantSlug as string,
    ...(identity.missionId ? { missionId: identity.missionId } : {}),
    ...(identity.taskId ? { taskId: identity.taskId } : {}),
    secrets: {},
  };
  return binding;
}

/** Called only after the coordinated port owns the WorkItem claim, inside its current envelope. */
export async function withConfiguredTaskCredentials<T>(
  workItemId: string,
  run: () => Promise<T>
): Promise<T> {
  if (hasTaskCredentialBinding()) return run();
  const envelope = currentScopeEnvelope();
  // No dispatch envelope means no claimed-task context: run unbound. Provider
  // access itself is fail-closed at point of use.
  if (!envelope) return run();
  const identity = credentialExecutionIdentity();
  if (!identity.tenantSlug) return run();
  if (envelope.identity.tenant_slug !== identity.tenantSlug)
    throw new Error('[CREDENTIAL_SCOPE_DENIED] Dispatch envelope contradicts runtime credentials');
  const resolver = getSecretResolver();
  const binder = resolver?.bindTask;
  let binding: TaskCredentialBinding | null = null;
  if (binder) {
    const scope: ScopeContext = assertScopeContext({
      ...envelope.identity,
      tier: envelope.policy.write_tier,
    });
    try {
      const input = Object.freeze({ scope: Object.freeze(scope), workItemId });
      binding = await binder.call(resolver, input);
    } catch {
      throw new Error(
        '[CREDENTIAL_BINDING_UNAVAILABLE] Configured resolver could not bind the current task'
      );
    }
  }
  return withTaskCredentialBinding(binding ?? mintLineageBinding(identity), run);
}
