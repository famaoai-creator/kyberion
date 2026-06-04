import { secretGuard } from './secret-guard.js';
import { getServiceEndpointRecord } from './service-endpoint-registry.js';

export function resolveServiceSecret(serviceId: string, suffixes: string[]): string | null {
  const upper = serviceId.toUpperCase();
  for (const suffix of suffixes) {
    const secret = secretGuard.getSecret(`${upper}_${suffix}`, serviceId);
    if (secret) return secret;
  }
  return null;
}

export function getServiceCredentialSuffixes(
  serviceId: string,
): Partial<Record<'accessToken' | 'appToken' | 'refreshToken' | 'clientId' | 'clientSecret' | 'redirectUri', string[]>> {
  return getServiceEndpointRecord(serviceId)?.credential_suffixes || {};
}
