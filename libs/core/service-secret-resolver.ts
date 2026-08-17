import { secretGuard } from './secret-guard.js';
import type { SecretReference } from './secret-resolver.js';
import { getServiceEndpointRecord } from './service-endpoint-registry.js';

export function resolveServiceSecret(serviceId: string, suffixes: string[]): string | null {
  const upper = serviceId.toUpperCase();
  for (const suffix of suffixes) {
    const secret = secretGuard.getSecret(`${upper}_${suffix}`, serviceId, 'service.resolve');
    if (secret) return secret;
  }
  return null;
}

/** Build a non-sensitive operation-scoped reference for a service credential. */
export function buildServiceSecretReference(
  serviceId: string,
  suffix: string,
  operation = 'service.resolve'
): SecretReference {
  const normalizedService = serviceId.trim();
  const normalizedSuffix = suffix.trim().toUpperCase();
  if (!normalizedService || !normalizedSuffix) {
    throw new Error('[SECRET_REFERENCE_INVALID] service and suffix are required');
  }
  return {
    env: `${normalizedService.toUpperCase()}_${normalizedSuffix}`,
    scope: normalizedService,
    operation,
  };
}

/** Select the first governed credential name without resolving its value. */
export function resolveServiceSecretReference(
  serviceId: string,
  suffixes: string[],
  operation = 'service.resolve'
): SecretReference | null {
  const suffix = suffixes.find((candidate) => candidate.trim());
  return suffix ? buildServiceSecretReference(serviceId, suffix, operation) : null;
}

/** Preserve every governed fallback candidate without resolving any value. */
export function resolveServiceSecretReferences(
  serviceId: string,
  suffixes: string[],
  operation = 'service.resolve'
): SecretReference[] {
  return suffixes
    .filter((suffix) => suffix.trim())
    .map((suffix) => buildServiceSecretReference(serviceId, suffix, operation));
}

export function getServiceCredentialSuffixes(
  serviceId: string
): Partial<
  Record<
    'accessToken' | 'appToken' | 'refreshToken' | 'clientId' | 'clientSecret' | 'redirectUri',
    string[]
  >
> {
  return getServiceEndpointRecord(serviceId)?.credential_suffixes || {};
}
