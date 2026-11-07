/**
 * secret-provider seam registry — the pluggable secret backend extension point.
 *
 * The builtin set (macOS Keychain, Windows Credential Manager, opt-in file
 * secrets, env secrets) lives in secret-bridge.ts and self-registers on
 * import. External providers — HashiCorp Vault, AWS Secrets Manager,
 * 1Password, etc. — register through {@link registerSecretProvider} instead
 * of editing the bridge; ordering is governed data
 * (`seam-provider-selection/secret-provider.json` `default_chains`).
 */

import { createProviderRegistry } from '../provider/provider-registry.js';
import type { SecretProvider } from './secret-types.js';
import type { SeamProviderMetadata } from '../seam.js';

export const SECRET_PROVIDER_SEAM = 'secret-provider';

const secretProviderRegistry = createProviderRegistry<SecretProvider>({
  seam: SECRET_PROVIDER_SEAM,
  owner: 'libs/core/secret/provider-registry.ts',
  source: 'secret-provider-extension',
  missingIdError: 'SecretProvider must have a non-empty id',
});

export function registerSecretProvider(
  provider: SecretProvider,
  metadata?: SeamProviderMetadata
): () => void {
  return secretProviderRegistry.register(provider, metadata);
}

export function listSecretProviders(): SecretProvider[] {
  return secretProviderRegistry.list();
}

export function getSecretProvider(id: string): SecretProvider | undefined {
  return secretProviderRegistry.get(id);
}

export function resetSecretProviders(): void {
  secretProviderRegistry.reset();
}
