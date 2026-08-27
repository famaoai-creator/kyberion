/** WebAuthn virtual passkey runtime isolated from browser pipeline orchestration. */

import { loadJson, logger, safeExistsSync, pathResolver } from '@agent/core';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';
import { type CDPSession, type Page } from '@playwright/test';
import type { BrowserRuntime } from './browser-pipeline-helpers.js';

function getPasskeyPreset(provider?: string) {
  const catalog = loadPasskeyProviderCatalog();
  const presetKey = provider || catalog.default_provider || 'webauthn.io';
  const preset = catalog.providers?.[presetKey];
  if (!preset) {
    throw new Error(`Unsupported passkey provider: ${presetKey}`);
  }
  return preset;
}

function loadPasskeyProviderCatalog(): {
  default_provider?: string;
  providers: Record<string, any>;
} {
  const passkeyProviderCatalogPath = pathResolver.knowledge(
    'product/orchestration/browser-passkey-providers.json'
  );
  if (safeExistsSync(passkeyProviderCatalogPath)) {
    try {
      const parsed = loadJson<{
        default_provider?: string;
        providers: Record<string, any>;
      }>(passkeyProviderCatalogPath);
      if (parsed && typeof parsed === 'object' && parsed.providers) return parsed;
    } catch (err) {
      logger.warn(
        `[browser-pipeline-helpers] suppressed error in loadPasskeyProviderCatalog: ${err}`
      );
    }
  }

  return {
    default_provider: 'webauthn.io',
    providers: {
      'webauthn.io': {
        baseUrl: 'https://webauthn.io/',
        usernameSelector: '#input-email',
        registerSelector: '#register-button',
        authenticateSelector: '#login-button',
        postAuthUrlIncludes: '/profile',
      },
    },
  };
}

export async function getOrCreatePageCdpSession(
  runtime: BrowserRuntime,
  page: Page
): Promise<CDPSession> {
  const existing = runtime.cdpSessions.get(page);
  if (existing) return existing;
  const session = await runtime.context.newCDPSession(page);
  runtime.cdpSessions.set(page, session);
  attachWebAuthnObservers(runtime, session);
  return session;
}

function attachWebAuthnObservers(runtime: BrowserRuntime, session: CDPSession): void {
  if (!runtime.webAuthn) {
    runtime.webAuthn = { enabled: false, credentials: [], events: [] };
  }

  session.on('WebAuthn.credentialAdded', (event: any) => {
    runtime.webAuthn!.events.push({
      type: 'credentialAdded',
      credential: event.credential,
      ts: new Date().toISOString(),
    });
    runtime.webAuthn!.credentials = upsertPasskeyCredential(
      runtime.webAuthn!.credentials,
      event.credential
    );
  });
  session.on('WebAuthn.credentialAsserted', (event: any) => {
    runtime.webAuthn!.events.push({
      type: 'credentialAsserted',
      credential: event.credential,
      ts: new Date().toISOString(),
    });
    runtime.webAuthn!.credentials = upsertPasskeyCredential(
      runtime.webAuthn!.credentials,
      event.credential
    );
  });
  session.on('WebAuthn.credentialDeleted', (event: any) => {
    runtime.webAuthn!.events.push({
      type: 'credentialDeleted',
      credentialId: event.credentialId,
      ts: new Date().toISOString(),
    });
    runtime.webAuthn!.credentials = runtime.webAuthn!.credentials.filter(
      (credential) => credential.credentialId !== event.credentialId
    );
  });
  session.on('WebAuthn.credentialUpdated', (event: any) => {
    runtime.webAuthn!.events.push({
      type: 'credentialUpdated',
      credential: event.credential,
      ts: new Date().toISOString(),
    });
    runtime.webAuthn!.credentials = upsertPasskeyCredential(
      runtime.webAuthn!.credentials,
      event.credential
    );
  });
}

export async function setupVirtualPasskeyAuthenticator(
  runtime: BrowserRuntime,
  page: Page,
  options: {
    enableUI: boolean;
    replaceExisting: boolean;
    protocol: 'ctap2' | 'u2f';
    transport: 'usb' | 'nfc' | 'ble' | 'internal';
    hasResidentKey: boolean;
    hasUserVerification: boolean;
    hasLargeBlob: boolean;
    automaticPresenceSimulation: boolean;
    isUserVerified: boolean;
  }
): Promise<Record<string, any>> {
  const cdp = await getOrCreatePageCdpSession(runtime, page);
  await cdp.send('WebAuthn.enable', { enableUI: options.enableUI });

  if (!runtime.webAuthn) {
    runtime.webAuthn = { enabled: true, credentials: [], events: [] };
  }
  runtime.webAuthn.enabled = true;

  if (options.replaceExisting !== false && runtime.webAuthn.authenticatorId) {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', {
      authenticatorId: runtime.webAuthn.authenticatorId,
    });
    runtime.webAuthn.credentials = [];
  }

  const authenticator = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: options.protocol,
      transport: options.transport,
      hasResidentKey: options.hasResidentKey,
      hasUserVerification: options.hasUserVerification,
      hasLargeBlob: options.hasLargeBlob,
      automaticPresenceSimulation: options.automaticPresenceSimulation,
      isUserVerified: options.isUserVerified,
    },
  });

  runtime.webAuthn.authenticatorId = authenticator.authenticatorId;
  runtime.webAuthn.options = {
    protocol: options.protocol,
    transport: options.transport,
    hasResidentKey: options.hasResidentKey,
    hasUserVerification: options.hasUserVerification,
    hasLargeBlob: options.hasLargeBlob,
    automaticPresenceSimulation: options.automaticPresenceSimulation,
    isUserVerified: options.isUserVerified,
  };

  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
    authenticatorId: authenticator.authenticatorId,
    enabled: options.automaticPresenceSimulation,
  });
  await cdp.send('WebAuthn.setUserVerified', {
    authenticatorId: authenticator.authenticatorId,
    isUserVerified: options.isUserVerified,
  });

  return {
    authenticator_id: authenticator.authenticatorId,
    ...runtime.webAuthn.options,
  };
}

export async function removeVirtualPasskeyAuthenticator(
  runtime: BrowserRuntime,
  page: Page
): Promise<void> {
  const authenticatorId = getPasskeyAuthenticatorId(runtime);
  const cdp = await getOrCreatePageCdpSession(runtime, page);
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  runtime.webAuthn = {
    enabled: true,
    credentials: [],
    events: [],
  };
}

export async function getVirtualPasskeyCredentials(
  runtime: BrowserRuntime,
  page: Page
): Promise<Array<Record<string, any>>> {
  const authenticatorId = getPasskeyAuthenticatorId(runtime);
  const cdp = await getOrCreatePageCdpSession(runtime, page);
  const result = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  const credentials = Array.isArray(result.credentials) ? result.credentials : [];
  if (!runtime.webAuthn) {
    runtime.webAuthn = { enabled: true, authenticatorId, credentials: [], events: [] };
  }
  runtime.webAuthn.credentials = credentials;
  return credentials;
}

export function getPasskeyAuthenticatorId(runtime: BrowserRuntime): string {
  const authenticatorId = runtime.webAuthn?.authenticatorId;
  if (!authenticatorId) {
    throw new Error(
      'No virtual passkey authenticator is active. Run setup_passkey_authenticator first.'
    );
  }
  return authenticatorId;
}

function upsertPasskeyCredential(
  credentials: Array<Record<string, any>>,
  nextCredential: Record<string, any> | undefined
): Array<Record<string, any>> {
  if (!nextCredential?.credentialId) return credentials;
  const next = credentials.filter(
    (credential) => credential.credentialId !== nextCredential.credentialId
  );
  next.push(nextCredential);
  return next;
}

export async function registerPasskey(
  page: Page,
  runtime: BrowserRuntime,
  ctx: any,
  params: any,
  resolve: Function
) {
  const preset = getPasskeyPreset(resolve(params.provider));
  const username = String(resolve(params.username ?? ctx.username ?? 'kyberion_passkey_user'));
  const waitMs = Number(params.wait_ms || 1500);
  if (params.navigate !== false) {
    const targetUrl = String(resolve(params.url || preset.baseUrl));
    browserRuntimeHelpers.assertNavigationAllowed(targetUrl, runtime.navigationPolicy);
    await page.goto(targetUrl, {
      waitUntil: params.waitUntil || 'networkidle',
    });
  }
  if (!runtime.webAuthn?.authenticatorId || params.setup_authenticator !== false) {
    await setupVirtualPasskeyAuthenticator(runtime, page, {
      enableUI: params.enable_ui === true,
      replaceExisting: params.replace_existing !== false,
      protocol: resolve(params.protocol || 'ctap2') as 'ctap2' | 'u2f',
      transport: resolve(params.transport || 'internal') as 'usb' | 'nfc' | 'ble' | 'internal',
      hasResidentKey: params.has_resident_key !== false,
      hasUserVerification: params.has_user_verification !== false,
      hasLargeBlob: params.has_large_blob === true,
      automaticPresenceSimulation: params.automatic_presence !== false,
      isUserVerified: params.user_verified !== false,
    });
  }
  await page.fill(resolve(params.username_selector || preset.usernameSelector), username, {
    timeout: params.timeout || 5000,
  });
  await page.click(resolve(params.register_selector || preset.registerSelector), {
    timeout: params.timeout || 5000,
  });
  await page.waitForTimeout(waitMs);
  const credentials = await getVirtualPasskeyCredentials(runtime, page);
  return {
    provider: resolve(params.provider || 'webauthn.io'),
    username,
    credentials,
    url: page.url(),
  };
}

export async function authenticatePasskey(
  page: Page,
  runtime: BrowserRuntime,
  ctx: any,
  params: any,
  resolve: Function
) {
  const preset = getPasskeyPreset(resolve(params.provider));
  const waitMs = Number(params.wait_ms || 1500);
  const username = params.username !== undefined ? String(resolve(params.username)) : undefined;
  let authPage = page;
  if (params.clear_session !== false) {
    await clearPasskeySiteSession(runtime, authPage);
  }
  if (preset.postAuthUrlIncludes && authPage.url().includes(preset.postAuthUrlIncludes)) {
    authPage = await openFreshPasskeyPage(runtime);
  }
  if (params.navigate !== false) {
    const targetUrl = String(resolve(params.url || preset.baseUrl));
    browserRuntimeHelpers.assertNavigationAllowed(targetUrl, runtime.navigationPolicy);
    await authPage.goto(targetUrl, {
      waitUntil: params.waitUntil || 'networkidle',
    });
  }
  if (preset.postAuthUrlIncludes && authPage.url().includes(preset.postAuthUrlIncludes)) {
    const credentials = await getVirtualPasskeyCredentials(runtime, authPage);
    return {
      provider: resolve(params.provider || 'webauthn.io'),
      username,
      credentials,
      url: authPage.url(),
      authenticated: true,
      mode: 'already_authenticated',
    };
  }
  try {
    if (username) {
      await authPage.fill(resolve(params.username_selector || preset.usernameSelector), username, {
        timeout: params.timeout || 5000,
      });
    }
    await authPage.click(resolve(params.authenticate_selector || preset.authenticateSelector), {
      timeout: params.timeout || 5000,
    });
  } catch (err) {
    if (preset.postAuthUrlIncludes && authPage.url().includes(preset.postAuthUrlIncludes)) {
      const credentials = await getVirtualPasskeyCredentials(runtime, authPage);
      return {
        provider: resolve(params.provider || 'webauthn.io'),
        username,
        credentials,
        url: authPage.url(),
        authenticated: true,
        mode: 'already_authenticated',
      };
    }
    throw err;
  }
  await authPage.waitForTimeout(waitMs);
  const credentials = await getVirtualPasskeyCredentials(runtime, authPage);
  return {
    provider: resolve(params.provider || 'webauthn.io'),
    username,
    credentials,
    url: authPage.url(),
    authenticated: preset.postAuthUrlIncludes
      ? authPage.url().includes(preset.postAuthUrlIncludes)
      : true,
  };
}

export async function deletePasskey(
  page: Page,
  runtime: BrowserRuntime,
  ctx: any,
  params: any,
  resolve: Function
) {
  const authenticatorId = getPasskeyAuthenticatorId(runtime);
  const cdp = await getOrCreatePageCdpSession(runtime, page);
  const credentials = await getVirtualPasskeyCredentials(runtime, page);
  let credentialToDelete: Record<string, any> | undefined;

  if (params.credential_id) {
    const credentialId = String(resolve(params.credential_id));
    credentialToDelete = credentials.find((credential) => credential.credentialId === credentialId);
  } else if (params.username) {
    const username = String(resolve(params.username));
    credentialToDelete = credentials.find(
      (credential) => credential.userName === username || credential.userDisplayName === username
    );
  } else if (credentials.length === 1) {
    credentialToDelete = credentials[0];
  }

  if (!credentialToDelete?.credentialId) {
    throw new Error(
      'Unable to determine passkey credential to delete. Provide credential_id or username.'
    );
  }

  await cdp.send('WebAuthn.removeCredential', {
    authenticatorId,
    credentialId: credentialToDelete.credentialId,
  });
  const remainingCredentials = await getVirtualPasskeyCredentials(runtime, page);
  return {
    deleted_credential_id: credentialToDelete.credentialId,
    credentials: remainingCredentials,
    deleted: true,
  };
}

async function clearPasskeySiteSession(runtime: BrowserRuntime, page: Page): Promise<void> {
  await runtime.context.clearCookies();
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
}

async function openFreshPasskeyPage(runtime: BrowserRuntime): Promise<Page> {
  const page = await runtime.context.newPage();
  const tabId = `tab-${runtime.tabs.size + 1}`;
  browserRuntimeHelpers.registerBrowserPage(runtime, page, tabId);
  runtime.activeTabId = tabId;
  if (runtime.webAuthn?.enabled && runtime.webAuthn.options) {
    await clonePasskeyAuthenticatorToPage(runtime, page);
  }
  return page;
}

async function clonePasskeyAuthenticatorToPage(runtime: BrowserRuntime, page: Page): Promise<void> {
  const options = runtime.webAuthn?.options;
  if (!options) return;

  const existingCredentials = [...(runtime.webAuthn?.credentials || [])];
  const cdp = await getOrCreatePageCdpSession(runtime, page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const authenticator = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: options.protocol,
      transport: options.transport,
      hasResidentKey: options.hasResidentKey,
      hasUserVerification: options.hasUserVerification,
      hasLargeBlob: options.hasLargeBlob,
      automaticPresenceSimulation: options.automaticPresenceSimulation,
      isUserVerified: options.isUserVerified,
    },
  });
  for (const credential of existingCredentials) {
    await cdp.send('WebAuthn.addCredential', {
      authenticatorId: authenticator.authenticatorId,
      credential: credential as any,
    });
  }
  runtime.webAuthn = {
    ...runtime.webAuthn,
    authenticatorId: authenticator.authenticatorId,
    credentials: existingCredentials,
  };
}
