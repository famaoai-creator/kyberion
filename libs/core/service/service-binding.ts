import type { ServiceAuthMode, CredentialSuffixKey } from './service-endpoint-registry.js';
export {
  getServiceEndpointRecord,
  getServiceEndpointRecordForIntent,
  loadServiceEndpointsCatalog,
  resolveServiceIdForIntent,
} from './service-endpoint-registry.js';
import {
  getServiceCredentialSuffixes,
  resolveServiceSecret,
  resolveServiceSecretReferences,
} from './service-secret-resolver.js';
import type { SecretReference } from '../secret/secret-resolver.js';

export interface ServiceBinding {
  serviceId: string;
  authMode: ServiceAuthMode;
  accessToken?: string;
  appToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  /** Non-sensitive env-name references retained for late-bound consumers. */
  secretReferences?: Partial<Record<CredentialSuffixKey, SecretReference[]>>;
  metadata?: Record<string, unknown>;
}

export function resolveServiceBinding(
  serviceId: string,
  authMode: 'none' | 'secret-guard' | 'session' = 'none'
): ServiceBinding {
  if (authMode === 'none') {
    return { serviceId, authMode };
  }

  if (authMode === 'session') {
    return {
      serviceId,
      authMode,
      metadata: {
        note: 'Session-based bindings must be resolved by the channel gateway or interactive control surface.',
      },
    };
  }

  // Suffixes are catalog-governed (service-endpoints.schema.json defaults applied
  // on load); no hardcoded fallback literals live here.
  const suffixes = getServiceCredentialSuffixes(serviceId);
  const referenceOperation = 'service.binding';
  const referenceEntry = (key: string, candidates: string[]) => {
    const references = resolveServiceSecretReferences(serviceId, candidates, referenceOperation);
    return references.length > 0 ? { [key]: references } : {};
  };
  const secretReferences = {
    ...referenceEntry('accessToken', suffixes.accessToken || []),
    ...referenceEntry('appToken', suffixes.appToken || []),
    ...referenceEntry('refreshToken', suffixes.refreshToken || []),
    ...referenceEntry('clientId', suffixes.clientId || []),
    ...referenceEntry('clientSecret', suffixes.clientSecret || []),
    ...referenceEntry('redirectUri', suffixes.redirectUri || []),
  };
  const accessToken = resolveServiceSecret(serviceId, suffixes.accessToken || []);
  const appToken = resolveServiceSecret(serviceId, suffixes.appToken || []);
  const refreshToken = resolveServiceSecret(serviceId, suffixes.refreshToken || []);
  const clientId = resolveServiceSecret(serviceId, suffixes.clientId || []);
  const clientSecret = resolveServiceSecret(serviceId, suffixes.clientSecret || []);
  const redirectUri = resolveServiceSecret(serviceId, suffixes.redirectUri || []);

  if (!accessToken && !appToken && !refreshToken && !clientId && !clientSecret && !redirectUri) {
    throw new Error(`Access denied: no service binding secret found for "${serviceId}"`);
  }

  return {
    serviceId,
    authMode,
    secretReferences,
    accessToken: accessToken || undefined,
    appToken: appToken || undefined,
    refreshToken: refreshToken || undefined,
    clientId: clientId || undefined,
    clientSecret: clientSecret || undefined,
    redirectUri: redirectUri || undefined,
    metadata: {
      serviceScoped: true,
      hasAccessToken: Boolean(accessToken),
      hasAppToken: Boolean(appToken),
      hasRefreshToken: Boolean(refreshToken),
      hasClientId: Boolean(clientId),
      hasClientSecret: Boolean(clientSecret),
      hasRedirectUri: Boolean(redirectUri),
    },
  };
}
