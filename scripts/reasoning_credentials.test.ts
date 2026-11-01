import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  introduce: vi.fn(),
  persist: vi.fn(),
  persistEnv: vi.fn(),
  read: vi.fn(),
  resolveKey: vi.fn(),
  verify: vi.fn(),
  write: vi.fn(),
  proof: vi.fn(),
}));
vi.mock('@agent/core/reasoning/reasoning-api-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/reasoning/reasoning-api-credentials')>()),
  resolveReasoningApiKey: mocks.resolveKey,
  verifyReasoningApiCredential: mocks.verify,
}));
vi.mock('@agent/core/foundation/json', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/foundation/json')>()),
  writeJson: mocks.write,
  readJsonIfPresent: mocks.proof,
}));
vi.mock('./secret_introduce.js', () => ({ runSecretCli: mocks.introduce }));
vi.mock('./reasoning_backend_selection.js', () => ({
  persistReasoningBackend: mocks.persist,
  persistEnvValue: mocks.persistEnv,
  readPersistedEnvValue: mocks.read,
}));
import { parseCredentialArgs, runCredentialCommand } from './reasoning_credentials.js';
import { resolveRole, withExecutionContextAsync } from '@agent/core/authority';
import { credentialExecutionIdentity } from '@agent/core/foundation/credential-binding';
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
describe('reasoning:credentials', () => {
  it('marks only recent proofs of the current key, model, endpoint and scope as verified', async () => {
    const { reasoningCredentialVersion, resolveReasoningApiModel } =
      await import('@agent/core/reasoning/reasoning-api-credentials');
    mocks.resolveKey.mockReturnValue('current-test-key');
    mocks.proof.mockReturnValue({
      provider: 'anthropic',
      status: 'success',
      transport: 'secure-fetch',
      checked_at: new Date().toISOString(),
      credential_version: reasoningCredentialVersion('current-test-key'),
      endpoint: 'https://api.anthropic.com/v1/messages',
      model: resolveReasoningApiModel('anthropic'),
      execution: { kind: 'operator' },
    });
    const print = vi.fn();
    await runCredentialCommand(['status', '--provider', 'anthropic'], print);
    expect(print).toHaveBeenLastCalledWith(expect.stringContaining('"verified":true'));
    const validProof = mocks.proof();
    for (const credential_version of ['a'.repeat(64), 'scrypt-v1:malformed']) {
      mocks.proof.mockReturnValue({ ...validProof, credential_version });
      await runCredentialCommand(['status', '--provider', 'anthropic'], print);
      expect(print).toHaveBeenLastCalledWith(expect.stringContaining('"verified":false'));
    }
    mocks.proof.mockReturnValue(validProof);
    mocks.resolveKey.mockReturnValue('rotated-test-key');
    await runCredentialCommand(['status', '--provider', 'anthropic'], print);
    expect(print).toHaveBeenLastCalledWith(expect.stringContaining('"verified":false'));
    expect(print.mock.calls.flat().join('')).not.toContain('current-test-key');
  });
  it('preserves tenant and task identity while checking credentials', async () => {
    mocks.resolveKey.mockImplementation(() => {
      expect(credentialExecutionIdentity()).toEqual({
        tenantSlug: 'alpha',
        missionId: 'MSN-A',
        taskId: 'task-a',
      });
      return undefined;
    });
    await withExecutionContextAsync(
      'reasoning_credentials',
      async () => {
        expect(await runCredentialCommand(['status', '--provider', 'anthropic'], () => {})).toBe(1);
      },
      undefined,
      'alpha',
      undefined,
      { missionId: 'MSN-A', taskId: 'task-a' }
    );
    expect(mocks.resolveKey).toHaveBeenCalledOnce();
  });

  it('rejects tenant registration before collecting or storing a personal key', async () => {
    await withExecutionContextAsync(
      'reasoning_credentials',
      async () => {
        await expect(
          runCredentialCommand(['register', '--provider', 'anthropic'], () => {})
        ).rejects.toThrow('Key registration requires an operator scope');
      },
      undefined,
      'alpha'
    );
    expect(mocks.introduce).not.toHaveBeenCalled();
  });
  it('uses secret introduction read authority for status without printing the key', async () => {
    mocks.resolveKey.mockImplementation(() => {
      expect(resolveRole()).toBe('secret_introduce');
      return 'test-private-key';
    });
    const print = vi.fn();
    expect(await runCredentialCommand(['status', '--provider', 'anthropic'], print)).toBe(0);
    expect(print.mock.calls.flat().join('')).not.toContain('test-private-key');
    expect(print).toHaveBeenCalledWith(expect.stringContaining('"configured":true'));
  });

  it('verifies under secret introduction authority and writes metadata after restoring the caller', async () => {
    mocks.verify.mockImplementation(async () => {
      await Promise.resolve();
      expect(resolveRole()).toBe('secret_introduce');
      return { provider: 'anthropic', model: 'test-model', status: 'success', code: 'verified' };
    });
    mocks.write.mockImplementation(() => expect(resolveRole()).toBe('reasoning_credentials'));
    await withExecutionContextAsync('reasoning_credentials', async () => {
      expect(
        await runCredentialCommand(
          ['verify', '--provider', 'anthropic', '--model', 'test-model', '--allow-paid'],
          () => {}
        )
      ).toBe(0);
      expect(resolveRole()).toBe('reasoning_credentials');
    });
    expect(mocks.write).toHaveBeenCalledOnce();
  });
  it('uses the secret introduction role across awaits and restores the caller role', async () => {
    mocks.introduce.mockImplementation(async () => {
      expect(resolveRole()).toBe('secret_introduce');
      await Promise.resolve();
      expect(resolveRole()).toBe('secret_introduce');
      return { status: 'pending' };
    });
    await withExecutionContextAsync('reasoning_credentials', async () => {
      expect(await runCredentialCommand(['register', '--provider', 'anthropic'], () => {})).toBe(1);
      expect(resolveRole()).toBe('reasoning_credentials');
    });
  });
  it.each([
    ['register', '--provider', 'openai', '--key', 'secret'],
    ['register', '--provider', 'codex-cli'],
    ['verify', '--provider', 'openai'],
    ['register', '--provider', 'openai', '--dry-run'],
    ['status', '--provider', 'openai', '--activate'],
  ])('rejects unsupported or secret-bearing arguments', (...args) => {
    expect(() => parseCredentialArgs(args)).toThrow();
  });
  it('keeps key registration independent of a model', () => {
    expect(parseCredentialArgs(['register', '--provider', 'openai'])).toMatchObject({
      action: 'register',
      provider: 'openai',
      model: undefined,
    });
  });
  it('does not activate a provider before secret introduction is applied', async () => {
    mocks.introduce.mockResolvedValue({ status: 'pending' });
    const code = await runCredentialCommand(
      ['register', '--provider', 'openai', '--model', 'test-model', '--activate'],
      () => {}
    );
    expect(code).toBe(1);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.persistEnv).not.toHaveBeenCalled();
  });
  it('reuses a configured model and activates the API mode rather than the Codex CLI alias', async () => {
    vi.stubEnv('KYBERION_OPENAI_MODEL', '');
    mocks.read.mockReturnValue('configured-model');
    mocks.introduce.mockResolvedValue({ status: 'applied' });
    expect(
      await runCredentialCommand(['register', '--provider', 'openai', '--activate'], () => {})
    ).toBe(0);
    expect(mocks.introduce).toHaveBeenCalledWith(
      ['introduce', 'openai', 'API_KEY', '--json'],
      expect.any(Object)
    );
    expect(mocks.persist).toHaveBeenCalledWith('openai-api');
    expect(mocks.persistEnv).not.toHaveBeenCalled();
  });
  it('requires a missing model before prompting for a key', async () => {
    vi.stubEnv('KYBERION_OPENAI_MODEL', '');
    mocks.read.mockReturnValue(null);
    await expect(
      runCredentialCommand(['register', '--provider', 'openai', '--activate'], () => {})
    ).rejects.toThrow('Select a model');
    expect(mocks.introduce).not.toHaveBeenCalled();
  });
  it('prints the descriptor-driven provider list', async () => {
    const print = vi.fn();
    expect(await runCredentialCommand(['--help'], print)).toBe(0);
    expect(print.mock.calls.flat().join('\n')).toContain('openai-api');
  });
});
