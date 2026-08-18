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
import type { SecretReference } from './secret-resolver.js';

export interface ServiceBinding {
  serviceId: string;
  authMode: 'none' | 'secret-guard' | 'session';
  accessToken?: string;
  appToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  /** Non-sensitive env-name references retained for late-bound consumers. */
  secretReferences?: Partial<
    Record<
      'accessToken' | 'appToken' | 'refreshToken' | 'clientId' | 'clientSecret' | 'redirectUri',
      SecretReference[]
    >
  >;
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

  const suffixes = getServiceCredentialSuffixes(serviceId);
  const referenceOperation = 'service.binding';
  const referenceEntry = (key: string, candidates: string[]) => {
    const references = resolveServiceSecretReferences(serviceId, candidates, referenceOperation);
    return references.length > 0 ? { [key]: references } : {};
  };
  const secretReferences = {
    ...referenceEntry(
      'accessToken',
      suffixes.accessToken || ['ACCESS_TOKEN', 'BOT_TOKEN', 'TOKEN']
    ),
    ...referenceEntry('appToken', suffixes.appToken || []),
    ...referenceEntry('refreshToken', suffixes.refreshToken || ['REFRESH_TOKEN']),
    ...referenceEntry('clientId', suffixes.clientId || ['CLIENT_ID']),
    ...referenceEntry('clientSecret', suffixes.clientSecret || ['CLIENT_SECRET']),
    ...referenceEntry('redirectUri', suffixes.redirectUri || []),
  };
  const accessToken = resolveServiceSecret(
    serviceId,
    suffixes.accessToken || ['ACCESS_TOKEN', 'BOT_TOKEN', 'TOKEN']
  );
  const appToken = resolveServiceSecret(serviceId, suffixes.appToken || []);
  const refreshToken = resolveServiceSecret(serviceId, suffixes.refreshToken || ['REFRESH_TOKEN']);
  const clientId = resolveServiceSecret(serviceId, suffixes.clientId || ['CLIENT_ID']);
  const clientSecret = resolveServiceSecret(serviceId, suffixes.clientSecret || ['CLIENT_SECRET']);
  const redirectUri = resolveServiceSecret(serviceId, suffixes.redirectUri || ['REDIRECT_URI']);

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
