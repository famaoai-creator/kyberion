import {
  assertCredentialOwner,
  credentialExecutionIdentity,
} from '../foundation/credential-binding.js';

/** Persistent native transports have not proved task-local auth/session isolation.
 * Reject tenant use rather than inheriting operator HOME or reusing a cached login.
 * Stateless provider CLI calls use the separate governed provider-env boundary. */
export function assertOperatorNativeCredentialOwner(
  owner: ReturnType<typeof credentialExecutionIdentity>
): void {
  assertCredentialOwner(owner);
  if (credentialExecutionIdentity().tenantSlug) {
    throw new Error(
      '[CREDENTIAL_NATIVE_UNSUPPORTED] Persistent native transport is unavailable for tenant execution'
    );
  }
}
