import { resolveTaskServiceCredential } from '../foundation/credential-binding.js';
import { secretGuard } from '../secret/secret-guard.js';
import type { SecretReference } from '../secret/secret-resolver.js';
import { getServiceEndpointRecord, type CredentialSuffixMap } from './service-endpoint-registry.js';

export function resolveServiceSecret(serviceId: string, suffixes: string[]): string | null {
  const upper = serviceId.toUpperCase();
  for (const suffix of suffixes) {
    // This resolver also serves actual requests and cached binding getters.
    // Discovery must handle optional absence at its boundary, never here.
    const secret = secretGuard.getSecret(`${upper}_${suffix}`, serviceId, 'service.resolve');
    if (secret) return secret;
  }
  return null;
}

/** Selected tenant binding references are the complete allowlist, not fallback suggestions. */
export function resolveSelectedServiceSecret(
  serviceId: string,
  suffixes: readonly string[],
  selection: {
    bindingId: string;
    ownerRef: string;
    secretRefs: readonly string[];
    allocationGrantId?: string;
  }
): string | null {
  for (const suffix of suffixes) {
    const key = buildServiceSecretReference(serviceId, suffix).env;
    if (!selection.secretRefs.includes(key)) continue;
    const value = resolveTaskServiceCredential(key, {
      serviceId,
      serviceBindingId: selection.bindingId,
      sourceOwnerRef: selection.ownerRef,
      allocationGrantId: selection.allocationGrantId,
    });
    if (!value)
      throw new Error('[CREDENTIAL_PROVENANCE_DENIED] Selected credential is unavailable');
    return value;
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

/**
 * Catalog-governed credential suffixes. The endpoint registry guarantees every
 * loaded record carries schema-defaulted suffixes, so an unknown service is an
 * explicit error here instead of a silent empty fallback.
 */
export function getServiceCredentialSuffixes(serviceId: string): CredentialSuffixMap {
  const record = getServiceEndpointRecord(serviceId);
  if (!record) {
    throw new Error(
      `[SERVICE_BINDING_UNKNOWN_SERVICE] no service endpoint record for "${serviceId}"`
    );
  }
  return record.credential_suffixes;
}
