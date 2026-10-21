/** Trusted standalone host adapter. Workers retain their original file/tool role. */
import { currentScopeEnvelope } from '../scope-envelope.js';
import { resolveScopeContext } from '../scope-context.js';
import {
  hasExternalOperationAuthority,
  withExternalOperationAuthority,
} from '../governance/external-operation.js';
import {
  createOnboardingExternalOperationAuthority,
  withInstalledPersonCharterRuntime,
} from '../governance/external-operation-runtime.js';
import type { CharterScope } from '../governance/accountability-charter.js';
import { inspectInstalledOnboardingRuntime } from './onboarding-runtime-identity.js';

export function withInstalledOnboardingAuthority<T>(invocationId: string, action: () => T): T {
  if (hasExternalOperationAuthority()) return action();
  const source = currentScopeEnvelope()?.identity ?? resolveScopeContext();
  const scope: CharterScope = source.tenant_slug
    ? { kind: 'organization', tenant_slug: source.tenant_slug }
    : { kind: 'person' };
  const installed = inspectInstalledOnboardingRuntime(scope);
  if (
    !installed.ready ||
    !installed.agentActive ||
    (source.nhi_id && source.nhi_id !== installed.agentId)
  )
    return action();
  const run = () =>
    withExternalOperationAuthority(
      createOnboardingExternalOperationAuthority({
        scope,
        agentId: installed.agentId,
        ownerActor: installed.ownerId,
        invocationId,
      }),
      action
    );
  return scope.kind === 'person'
    ? withInstalledPersonCharterRuntime(
        { ownerActor: installed.ownerId, agentId: installed.agentId },
        run
      )
    : run();
}
