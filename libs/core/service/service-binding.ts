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
  authMode: 'none' | 'secret-guard' | 'session' = 'none',
  credentialKeys?: readonly CredentialSuffixKey[]
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
  const selected = (key: CredentialSuffixKey): string[] =>
    !credentialKeys || credentialKeys.includes(key) ? suffixes[key] || [] : [];
  const referenceOperation = 'service.binding';
  const referenceEntry = (key: string, candidates: string[]) => {
    const references = resolveServiceSecretReferences(serviceId, candidates, referenceOperation);
    return references.length > 0 ? { [key]: references } : {};
  };
  const secretReferences = {
    ...referenceEntry('accessToken', selected('accessToken')),
    ...referenceEntry('appToken', selected('appToken')),
    ...referenceEntry('refreshToken', selected('refreshToken')),
    ...referenceEntry('clientId', selected('clientId')),
    ...referenceEntry('clientSecret', selected('clientSecret')),
    ...referenceEntry('redirectUri', selected('redirectUri')),
  };
  const accessToken = resolveServiceSecret(serviceId, selected('accessToken'));
  const appToken = resolveServiceSecret(serviceId, selected('appToken'));
  const refreshToken = resolveServiceSecret(serviceId, selected('refreshToken'));
  const clientId = resolveServiceSecret(serviceId, selected('clientId'));
  const clientSecret = resolveServiceSecret(serviceId, selected('clientSecret'));
  const redirectUri = resolveServiceSecret(serviceId, selected('redirectUri'));

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
