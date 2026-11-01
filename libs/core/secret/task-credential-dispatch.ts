import { getSecretResolver } from './secret-resolver.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import {
  credentialExecutionIdentity,
  hasTaskCredentialBinding,
  withTaskCredentialBinding,
} from '../foundation/credential-binding.js';
import { assertScopeContext, type ScopeContext } from '../scope-context-validation.js';

/** Called only after the coordinated port owns the WorkItem claim, inside its current envelope. */
export async function withConfiguredTaskCredentials<T>(
  workItemId: string,
  run: () => Promise<T>
): Promise<T> {
  if (hasTaskCredentialBinding()) return run();
  const envelope = currentScopeEnvelope();
  const resolver = getSecretResolver();
  const binder = resolver?.bindTask;
  // Legacy non-credential delegation remains usable. Provider access itself is fail-closed.
  if (!envelope || !binder) return run();
  const identity = credentialExecutionIdentity();
  if (!identity.tenantSlug) return run();
  if (envelope.identity.tenant_slug !== identity.tenantSlug)
    throw new Error('[CREDENTIAL_SCOPE_DENIED] Dispatch envelope contradicts runtime credentials');
  const scope: ScopeContext = assertScopeContext({
    ...envelope.identity,
    tier: envelope.policy.write_tier,
  });
  let binding;
  try {
    const input = Object.freeze({ scope: Object.freeze(scope), workItemId });
    binding = await binder.call(resolver, input);
  } catch {
    throw new Error(
      '[CREDENTIAL_BINDING_UNAVAILABLE] Configured resolver could not bind the current task'
    );
  }
  return binding ? withTaskCredentialBinding(binding, run) : run();
}
