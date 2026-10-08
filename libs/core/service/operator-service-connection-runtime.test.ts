import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentManifest } from '../agent/agent-manifest.js';

const fixture = vi.hoisted(() => ({
  root: process.cwd() + '/active/shared/tmp/operator-service-registration-fixture-' + process.pid,
  keychain: new Map<string, string>(),
  secureFetch: vi.fn(),
  storeSecret: vi.fn(),
  recordUnclassified: vi.fn(),
}));

// Keep the real guard, atomic secure writer, cache, catalog, binding and actuator.
// Only relocate private stores into an isolated synthetic fixture; never touch
// the operator's actual connection files, vault, or mission grants.
vi.mock('../path-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../path-resolver.js')>('../path-resolver.js');
  const resolve = (relative: string) =>
    relative.startsWith('knowledge/personal/connections') ||
    relative === 'vault/secrets/secrets.json' ||
    relative === 'active/shared/auth-grants.json'
      ? fixture.root + '/' + relative
      : actual.resolve(relative);
  return { ...actual, resolve, pathResolver: { ...actual.pathResolver, resolve } };
});
vi.mock('../secret/secret-bridge.js', () => ({
  storeSecret: fixture.storeSecret,
  fetchSecretSync: (service: string, account: string) =>
    fixture.keychain.get(service + ':' + account) ?? null,
}));
vi.mock('../network.js', async () => ({
  ...(await vi.importActual<typeof import('../network.js')>('../network.js')),
  secureFetch: fixture.secureFetch,
}));
vi.mock('../ledger.js', () => ({ ledger: { record: vi.fn() } }));
vi.mock('../unclassified-error-registry.js', async () => ({
  ...(await vi.importActual<typeof import('../unclassified-error-registry.js')>(
    '../unclassified-error-registry.js'
  )),
  recordUnclassifiedError: fixture.recordUnclassified,
}));

import {
  safeChmodSync,
  safeExistsSync,
  safeRmSync,
  safeStat,
  safeWriteFile,
  withSensitivePathMediation,
} from '../secure-io.js';
import { logger } from '../core.js';
import {
  applySecretIntroduction,
  proposeSecretIntroduction,
} from '../secret/secret-introduction.js';
import { getSecret, grantAccess, storeConnectionDocument } from '../secret/secret-guard.js';
import { registeredServiceAccessCredentialPresent } from './operator-service-connection-catalog.js';
import { validateRequirements } from '../agent/agent-manifest.js';
import { resetOpPreflight } from '../pipeline/op-preflight.js';
import { withPluginExecutionFrame } from '../shell/sandbox-policy.js';
import { handleAction } from '../../actuators/service-actuator/src/index.js';

const manifest: AgentManifest = {
  agentId: 'synthetic-preset-agent',
  capabilities: ['service'],
  autoSpawn: false,
  trustRequired: 0,
  requires: { services: ['github'] },
  allowedActuators: ['service-actuator'],
  deniedActuators: [],
  systemPrompt: '',
  filePath: '',
};

beforeAll(() => {
  for (const key of [
    'AUTHORIZED_SCOPE',
    'MISSION_ID',
    'GITHUB_ACCESS_TOKEN',
    'GITHUB_BOT_TOKEN',
    'GITHUB_TOKEN',
    'SLACK_ACCESS_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_TOKEN',
    'SLACK_APP_TOKEN',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('KYBERION_SECRET_ENCRYPTION', 'none');
  fixture.storeSecret.mockImplementation(
    async (service: string, account: string, value: string) => {
      fixture.keychain.set(service + ':' + account, value);
    }
  );
  fixture.secureFetch.mockResolvedValue([{ id: 7, name: 'synthetic-private-repository' }]);
});
afterAll(() => {
  resetOpPreflight();
  vi.unstubAllEnvs();
  withSensitivePathMediation(() => {
    if (safeExistsSync(fixture.root)) safeRmSync(fixture.root, { recursive: true, force: true });
  });
});

describe('Web registration into a normal authorized service-actuator runtime', () => {
  it('discovers and consumes the saved token through PRESET list_repos only after independent mission authority', async () => {
    // An OAuth client secret alone does not enable a bearer runtime.
    const previous = storeConnectionDocument(
      'github',
      { client_secret: 'synthetic-client-secret' },
      { backup: false }
    );
    if (process.platform !== 'win32') {
      withSensitivePathMediation(() => {
        safeChmodSync(previous.path, 0o644);
        safeWriteFile(previous.path + '.bak', '{"synthetic":"old-backup"}', { mode: 0o644 });
        safeChmodSync(previous.path + '.bak', 0o644);
        expect(safeStat(previous.path).mode & 0o777).toBe(0o644);
        expect(safeStat(previous.path + '.bak').mode & 0o777).toBe(0o644);
      });
    }
    expect(registeredServiceAccessCredentialPresent('github')).toBe(false);
    expect(validateRequirements(manifest).ok).toBe(false);

    const principalId = 'human:synthetic-local-operator';
    const token = 'synthetic-web-registered-access-token';
    const proposal = proposeSecretIntroduction({
      serviceId: 'github',
      secretKey: 'ACCESS_TOKEN',
      reason: 'Synthetic local-operator Web registration runtime proof',
      channel: 'concierge',
      storageChannel: 'concierge',
      requestedBy: principalId,
      requestedByContext: { surface: 'api', actorId: principalId, actorRole: 'sovereign' },
      autoApproveLocal: true,
    });
    const applied = await applySecretIntroduction({
      approvalId: proposal.approvalId,
      value: token,
      appliedBy: principalId,
      expected: {
        principalId,
        serviceId: 'github',
        secretKey: 'ACCESS_TOKEN',
        channel: 'concierge',
        storageChannel: 'concierge',
      },
    });
    expect(applied.status).toBe('applied');
    expect(fixture.storeSecret).toHaveBeenCalledWith('github', 'access_token', token);
    expect(applied.connectionPath).toContain(fixture.root);
    expect(getSecret('GITHUB_ACCESS_TOKEN')).toBe(token);
    expect(registeredServiceAccessCredentialPresent('github')).toBe(true);
    const discovered = validateRequirements(manifest);
    expect(discovered).toEqual({ ok: true, reasons: [] });
    expect(JSON.stringify([proposal, applied, discovered])).not.toContain(token);

    // This discovery does not bypass explicit CLI or gateway environment contracts.
    expect(
      validateRequirements({
        ...manifest,
        requires: { services: ['github'], env: ['GITHUB_TOKEN'] },
      }).ok
    ).toBe(false);
    withPluginExecutionFrame(
      {
        pluginId: 'synthetic-no-secret-plugin',
        grant: {
          network: { mode: 'none', hosts: [] },
          fs: { mode: 'none', paths: [] },
          ops_invoke: [],
          env: [],
          secrets: [],
        },
      },
      () => {
        expect(registeredServiceAccessCredentialPresent('github')).toBe(false);
      }
    );

    const action = {
      service_id: 'github',
      mode: 'PRESET' as const,
      action: 'list_repos',
      params: { per_page: 1 },
      auth: 'secret-guard' as const,
    };
    // Public actuator entry and real preflight, not an internal probe shortcut.
    await expect(handleAction(action)).rejects.toThrow('TIBA_VIOLATION');
    expect(fixture.secureFetch).not.toHaveBeenCalled();
    const missionId = 'MSN-SYNTHETIC-WEB-REGISTERED-RUNTIME';
    grantAccess(missionId, 'github', 1);
    vi.stubEnv('MISSION_ID', missionId);
    expect(await handleAction(action)).toEqual([{ id: 7, name: 'synthetic-private-repository' }]);
    expect(fixture.secureFetch).toHaveBeenCalledTimes(1);
    expect(fixture.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.github.com/user/repos',
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token },
        params: { per_page: 1 },
      })
    );
    expect(fixture.secureFetch.mock.calls[0][0]).not.toHaveProperty('maxRedirects');
    expect(process.env.GITHUB_TOKEN).toBe('');
    expect(process.env.GITHUB_ACCESS_TOKEN).toBe('');

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    fixture.recordUnclassified.mockClear();
    fixture.secureFetch.mockRejectedValue(new Error('Network Error: provider echoed ' + token));
    await expect(handleAction(action)).rejects.toThrow('All service alternatives failed');
    expect(JSON.stringify([warn.mock.calls, error.mock.calls])).not.toContain(token);
    expect(fixture.recordUnclassified).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();

    // Atomic credential and raw backup creation is private even in plaintext mode.
    if (process.platform !== 'win32') {
      withSensitivePathMediation(() => {
        expect(safeStat(applied.connectionPath).mode & 0o777).toBe(0o600);
        expect(safeStat(applied.connectionPath + '.bak').mode & 0o777).toBe(0o600);
      });
    }
  });
});
