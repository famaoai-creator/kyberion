import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretProvider } from './secret-types.js';

// Real seam policy + selection engine; only the audit chain is mocked and
// MISSION_ID stays unset so no pin file is written.
vi.mock('../governance/audit-chain.js', () => ({
  auditChain: { record: vi.fn() },
}));

const { selectSecretProvider } = await import('./secret-bridge.js');

function fake(id: string, available: boolean): SecretProvider {
  return {
    id,
    isAvailable: async () => available,
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
  };
}

const PROVIDERS = [
  fake('env_secrets', true),
  fake('file_secrets', false),
  fake('hashicorp_vault', true),
];

describe('secret-provider saved seam default', () => {
  beforeEach(() => vi.stubEnv('MISSION_ID', ''));
  afterEach(() => vi.unstubAllEnvs());

  it('follows the policy chain without a saved default', async () => {
    expect((await selectSecretProvider(PROVIDERS)).id).toBe('hashicorp_vault');
  });

  it('lets an available saved default lead the chain', async () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'secret-provider=env_secrets');
    expect((await selectSecretProvider(PROVIDERS)).id).toBe('env_secrets');
  });

  it('ignores an unavailable saved default (isAvailable stays the hard filter)', async () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'secret-provider=file_secrets');
    expect((await selectSecretProvider(PROVIDERS)).id).toBe('hashicorp_vault');
  });
});
