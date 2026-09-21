import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeSecret = vi.fn(async () => undefined);
const fetchSecretSync = vi.fn(() => null);
const storeConnectionDocument = vi.fn(() => ({
  path: 'knowledge/personal/connections/gemini.json',
  changedKeys: ['api_key'],
}));
const getSecret = vi.fn(() => null);

vi.mock('./secret-bridge.js', () => ({
  storeSecret,
  fetchSecretSync,
}));

vi.mock('./secret-guard.js', () => ({
  getSecret,
  storeConnectionDocument,
}));

vi.mock('./ledger.js', () => ({
  ledger: { record: vi.fn() },
}));

describe('secret-introduction façade', () => {
  beforeEach(() => {
    vi.resetModules();
    storeSecret.mockClear();
    fetchSecretSync.mockClear();
    storeConnectionDocument.mockClear();
    getSecret.mockClear();
    process.env.KYBERION_ALLOW_FILE_SECRETS = '1';
  });

  afterEach(() => {
    delete process.env.KYBERION_ALLOW_FILE_SECRETS;
  });

  it('proposes without embedding a secret value and auto-approves low risk', async () => {
    const { proposeSecretIntroduction } = await import('./secret-introduction.js');
    const proposed = proposeSecretIntroduction({
      serviceId: 'gemini',
      secretKey: 'API_KEY',
      reason: 'Enable Gemini media ops',
      autoApproveLocal: true,
      channel: 'terminal',
      requestedBy: 'operator',
    });
    expect(proposed.approvalId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(proposed.status).toBe('approved');
    expect(proposed.autoApproved).toBe(true);
    expect(proposed.identity.envName).toBe('GEMINI_API_KEY');

    const { loadApprovalRequest } = await import('./approval-store.js');
    const record = loadApprovalRequest(proposed.storageChannel, proposed.approvalId);
    expect(record?.kind).toBe('secret_mutation');
    expect(JSON.stringify(record)).not.toMatch(/sk-|api[_-]?key[_-]?value/i);
    expect(record?.target?.secretKey).toBe('API_KEY');
  });

  it('applies dual-write only when approved and never echoes the value', async () => {
    const { proposeSecretIntroduction, applySecretIntroduction } =
      await import('./secret-introduction.js');
    const proposed = proposeSecretIntroduction({
      serviceId: 'gemini',
      secretKey: 'API_KEY',
      reason: 'test apply',
      autoApproveLocal: true,
      channel: 'terminal',
      requestedBy: 'operator',
    });

    const secretValue = `test-secret-${Date.now()}`;
    const applied = await applySecretIntroduction({
      approvalId: proposed.approvalId,
      value: secretValue,
      storageChannel: proposed.storageChannel,
      channel: proposed.channel,
      appliedBy: 'operator',
    });

    expect(storeSecret).toHaveBeenCalledWith('gemini', 'api_key', secretValue);
    expect(storeConnectionDocument).toHaveBeenCalledWith(
      'gemini',
      { api_key: secretValue },
      expect.objectContaining({ actor: 'secret_introduction' })
    );
    expect(applied.status).toBe('applied');
    expect(JSON.stringify(applied)).not.toContain(secretValue);
  });

  it('rejects apply when approval is still pending', async () => {
    const { proposeSecretIntroduction, applySecretIntroduction } =
      await import('./secret-introduction.js');
    const proposed = proposeSecretIntroduction({
      serviceId: 'gemini',
      secretKey: 'API_KEY',
      reason: 'pending apply',
      autoApproveLocal: false,
      riskLevel: 'high',
      channel: 'terminal',
      requestedBy: 'operator',
    });
    expect(proposed.status).toBe('pending');
    await expect(
      applySecretIntroduction({
        approvalId: proposed.approvalId,
        value: 'should-not-apply',
        storageChannel: proposed.storageChannel,
      })
    ).rejects.toThrow(/must be approved/);
    expect(storeSecret).not.toHaveBeenCalled();
  });
});

describe('describeIntroductionReadiness', () => {
  it('lists missing env names without values', async () => {
    getSecret.mockReturnValue(null);
    fetchSecretSync.mockReturnValue(null);
    const { describeIntroductionReadiness } = await import('./secret-introduction.js');
    const readiness = describeIntroductionReadiness('gemini');
    expect(readiness.missing.length).toBeGreaterThan(0);
    expect(readiness.missing.every((name) => name.startsWith('GEMINI_'))).toBe(true);
    expect(JSON.stringify(readiness)).not.toMatch(/sk-/);
  });
});
