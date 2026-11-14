import { listOperatorServiceConnections } from '../service/operator-service-connection.js';
import { runOperatorServiceProbeScope } from '../service/operator-service-connection-admission.js';
import { listCredentialAllocations } from '../secret/credential-allocations.js';
import { loadConnectionDocument, storeConnectionDocument } from '../secret/secret-guard.js';
import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { buildProviderChildEnv } from './provider-permission-profiles.js';
import { createAnthropicCredentialClient } from './anthropic-credential-client.js';
import { assertOperatorNativeCredentialOwner } from '../agent/native-credential-fence.js';
import { credentialExecutionIdentity } from '../foundation/credential-binding.js';

// Exercise operator seams independently of dispatch/claim minting, which has
// its own integration tests. No client, native process or account is invoked.
vi.mock('../foundation/credential-binding.js', async (original) => ({
  ...(await original<typeof import('../foundation/credential-binding.js')>()),
  credentialExecutionIdentity: () => ({
    personalClaim: {
      ownerId: 'user:owner',
      actorId: 'worker-a',
      workItemId: 'work-a',
      attemptId: 'attempt-a',
      leaseId: 'lease-a',
    },
  }),
  assertCredentialOwner: vi.fn(),
}));

describe('personal claimed execution cannot inherit operator provider authority', () => {
  it('rejects operator connection documents and tenant allocation enumeration', () => {
    expect(() => loadConnectionDocument('github')).toThrow('CREDENTIAL_CONNECTION_DENIED');
    expect(() => storeConnectionDocument('github', { token: 'forbidden' })).toThrow(
      'CREDENTIAL_CONNECTION_DENIED'
    );
    expect(() => listCredentialAllocations('acme')).toThrow('CREDENTIAL_ALLOCATION_DENIED');
  });

  it('rejects operator catalog and probe scope despite a loopback principal', async () => {
    expect(() =>
      listOperatorServiceConnections({
        principalId: 'user:owner',
        role: 'localadmin',
        source: 'loopback',
        loopback: true,
      })
    ).toThrow('OPERATOR_SERVICE_CONNECTION_DENIED');
    const run = vi.fn();
    await expect(
      runOperatorServiceProbeScope('github', 'read', ['GITHUB_TOKEN'], run)
    ).rejects.toThrow('OPERATOR_SERVICE_PROBE_DENIED');
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects ambient CLI environment even with the allowlist escape hatch', () => {
    expect(() =>
      buildProviderChildEnv({
        provider: 'codex',
        baseEnv: {
          HOME: '/operator',
          OPENAI_API_KEY: 'operator-fixture',
          KYBERION_PROVIDER_ENV_ALLOWLIST: '0',
        },
      })
    ).toThrow('CREDENTIAL_HOME_INVALID');
  });

  it('rejects opaque SDK injection and explicit operator key before constructing a client', () => {
    const create = vi.fn();
    const client = { messages: { create } } as unknown as Anthropic;
    expect(() => createAnthropicCredentialClient({ client })).toThrow('CREDENTIAL_OWNER_DENIED');
    expect(() => createAnthropicCredentialClient({ operatorApiKey: 'operator-fixture' })).toThrow(
      'CREDENTIAL_OWNER_DENIED'
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects persistent native transports despite matching captured ownership', () => {
    expect(() => assertOperatorNativeCredentialOwner(credentialExecutionIdentity())).toThrow(
      'CREDENTIAL_NATIVE_UNSUPPORTED'
    );
  });
});
