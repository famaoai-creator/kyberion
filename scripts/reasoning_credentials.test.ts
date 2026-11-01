import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  introduce: vi.fn(),
  persist: vi.fn(),
  persistEnv: vi.fn(),
  read: vi.fn(),
}));
vi.mock('./secret_introduce.js', () => ({ runSecretCli: mocks.introduce }));
vi.mock('./reasoning_backend_selection.js', () => ({
  persistReasoningBackend: mocks.persist,
  persistEnvValue: mocks.persistEnv,
  readPersistedEnvValue: mocks.read,
}));
import { parseCredentialArgs, runCredentialCommand } from './reasoning_credentials.js';
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
describe('reasoning:credentials', () => {
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
