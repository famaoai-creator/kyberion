import { secretGuard } from './secret-guard.js';

export interface ServiceBinding {
  serviceId: string;
  authMode: 'none' | 'secret-guard' | 'session';
  accessToken?: string;
  appToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  metadata?: Record<string, unknown>;
}

function resolveServiceSecret(serviceId: string, suffixes: string[]): string | null {
  const upper = serviceId.toUpperCase();
  for (const suffix of suffixes) {
    const secret = secretGuard.getSecret(`${upper}_${suffix}`, serviceId);
    if (secret) return secret;
  }
  return null;
}

export function resolveServiceBinding(serviceId: string, authMode: 'none' | 'secret-guard' | 'session' = 'none'): ServiceBinding {
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

  const accessToken = resolveServiceSecret(serviceId, ['ACCESS_TOKEN', 'BOT_TOKEN', 'TOKEN']);
  const appToken = serviceId === 'slack' ? resolveServiceSecret(serviceId, ['APP_TOKEN']) : null;
  const refreshToken = resolveServiceSecret(serviceId, ['REFRESH_TOKEN']);
  const clientId = resolveServiceSecret(serviceId, ['CLIENT_ID']);
  const clientSecret = resolveServiceSecret(serviceId, ['CLIENT_SECRET']);
  const redirectUri = resolveServiceSecret(serviceId, ['REDIRECT_URI']);

  if (!accessToken && !appToken && !refreshToken && !clientId && !clientSecret && !redirectUri) {
    throw new Error(`Access denied: no service binding secret found for "${serviceId}"`);
  }

  return {
    serviceId,
    authMode,
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
