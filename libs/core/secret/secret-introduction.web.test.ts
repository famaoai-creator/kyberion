import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as approvalStore from '../governance/approval-store.js';
import { writeGovernedArtifactJson } from '../workforce/artifact-store.js';
import * as secureIo from '../secure-io.js';
import {
  applySecretIntroduction,
  proposeSecretIntroduction,
  SECRET_INTRODUCTION_RECOVERY_REQUIRED,
  SECRET_INTRODUCTION_WEB_TOKEN_MAX_BYTES,
  type ProposeSecretIntroductionInput,
  type SecretIntroductionApplyExpectation,
} from './secret-introduction.js';

const { storeSecret, storeConnectionDocument, ledgerRecord } = vi.hoisted(() => ({
  storeSecret: vi.fn(),
  storeConnectionDocument: vi.fn(),
  ledgerRecord: vi.fn(),
}));
vi.mock('./secret-bridge.js', () => ({ storeSecret, fetchSecretSync: () => null }));
vi.mock('./secret-guard.js', () => ({ getSecret: () => null, storeConnectionDocument }));
vi.mock('../ledger.js', () => ({ ledger: { record: ledgerRecord } }));

const expected: SecretIntroductionApplyExpectation = {
  principalId: 'local-operator-test',
  serviceId: 'github',
  secretKey: 'ACCESS_TOKEN',
  channel: 'concierge',
  storageChannel: 'concierge',
};
const token = 'mock-registration-credential';

function propose(overrides: Partial<ProposeSecretIntroductionInput> = {}) {
  return proposeSecretIntroduction({
    serviceId: expected.serviceId,
    secretKey: expected.secretKey,
    requestedBy: expected.principalId,
    requestedByContext: { surface: 'api', actorId: expected.principalId, actorRole: 'sovereign' },
    reason: 'Hermetic Web registration test',
    channel: 'concierge',
    storageChannel: 'concierge',
    autoApproveLocal: true,
    ...overrides,
  });
}
function read(approvalId: string) {
  const record = approvalStore.loadApprovalRequest('concierge', approvalId);
  expect(record).not.toBeNull();
  return record!;
}
function rewrite(approvalId: string, changes: Partial<approvalStore.ApprovalRequestRecord>) {
  writeGovernedArtifactJson(
    'mission_controller',
    approvalStore.approvalRequestLogicalPath('concierge', approvalId),
    { ...read(approvalId), ...changes }
  );
}
function apply(approvalId: string, value = token) {
  return applySecretIntroduction({ approvalId, value, expected });
}
function expectNoWrites() {
  expect(storeSecret).not.toHaveBeenCalled();
  expect(storeConnectionDocument).not.toHaveBeenCalled();
}

beforeEach(() => {
  storeSecret.mockReset().mockResolvedValue(undefined);
  storeConnectionDocument.mockReset().mockReturnValue({
    path: 'knowledge/personal/connections/github.json',
    changedKeys: ['access_token'],
  });
  ledgerRecord.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('strict server-bound secret introduction', () => {
  it('binds apply and its durable claim to the server principal without storing the token', async () => {
    const proposed = propose();
    const result = await apply(proposed.approvalId);
    expect(result.status).toBe('applied');
    const record = read(proposed.approvalId);
    expect(record.applyClaim).toMatchObject({ startedBy: expected.principalId });
    expect(record.applyClaim?.claimId).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.applyResult).toMatchObject({
      appliedBy: expected.principalId,
      result: 'success',
    });
    expect(JSON.stringify(record)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(storeSecret).toHaveBeenCalledWith('github', 'access_token', token);
    await expect(apply(proposed.approvalId)).rejects.toThrow('already applied');
    expect(storeSecret).toHaveBeenCalledTimes(1);
  });

  it.each(['medium', 'high', 'critical'] as const)(
    'never auto-approves explicit true at %s risk',
    (riskLevel) => {
      expect(propose({ riskLevel })).toMatchObject({ status: 'pending', autoApproved: false });
    }
  );
  it.each(['slack', 'presence', 'system'] as const)(
    'never auto-approves unsupported %s surface',
    (surface) => {
      expect(
        propose({
          requestedByContext: {
            surface,
            actorId: expected.principalId,
            actorRole: 'sovereign',
          },
        })
      ).toMatchObject({ status: 'pending', autoApproved: false });
    }
  );
  it.each(['requestedBy', 'actorId'] as const)(
    'rejects another %s even with an approved request',
    async (field) => {
      const proposed = propose(
        field === 'requestedBy'
          ? { requestedBy: 'other-operator' }
          : {
              requestedByContext: {
                surface: 'api',
                actorId: 'other-operator',
                actorRole: 'sovereign',
              },
            }
      );
      await expect(apply(proposed.approvalId)).rejects.toThrow('server principal and target');
      expectNoWrites();
      expect(read(proposed.approvalId).applyClaim).toBeUndefined();
    }
  );
  it('rejects a missing requester context', async () => {
    const proposed = propose();
    rewrite(proposed.approvalId, { requestedByContext: undefined });
    await expect(apply(proposed.approvalId)).rejects.toThrow('server principal and target');
    expectNoWrites();
  });
  it.each([{ serviceId: 'slack' }, { secretKey: 'BOT_TOKEN' }])(
    'rejects a different target %j',
    async (target) => {
      const proposed = propose(target);
      await expect(apply(proposed.approvalId)).rejects.toThrow('target does not match');
      expectNoWrites();
    }
  );
  it.each(['channel', 'storageChannel'] as const)('rejects changed record %s', async (field) => {
    const proposed = propose();
    rewrite(proposed.approvalId, { [field]: 'terminal' });
    await expect(apply(proposed.approvalId)).rejects.toThrow('server principal and target');
    expectNoWrites();
  });
  it('rejects caller-selected storage or an unrelated applying actor', async () => {
    const proposed = propose();
    await expect(
      applySecretIntroduction({
        approvalId: proposed.approvalId,
        value: token,
        expected,
        storageChannel: 'terminal',
      })
    ).rejects.toThrow('channel does not match');
    await expect(
      applySecretIntroduction({
        approvalId: proposed.approvalId,
        value: token,
        expected,
        appliedBy: 'other-operator',
      })
    ).rejects.toThrow('server principal and target');
    expectNoWrites();
  });
  it.each([undefined, '', 'not-a-date', '2000-01-01T00:00:00.000Z'])(
    'rejects expiry %s',
    async (expiresAt) => {
      const proposed = propose();
      rewrite(proposed.approvalId, { expiresAt });
      await expect(apply(proposed.approvalId)).rejects.toThrow('valid expiry');
      expectNoWrites();
    }
  );
  it.each([
    { serviceId: 'GITHUB' },
    { secretKey: 'access_token' },
    { mutation: 'delete' as const },
    { store: 'vault' as const },
  ])('rejects noncanonical or unsupported target %j', async (change) => {
    const proposed = propose();
    rewrite(proposed.approvalId, { target: { ...read(proposed.approvalId).target!, ...change } });
    await expect(apply(proposed.approvalId)).rejects.toThrow('server principal and target');
    expectNoWrites();
  });
  it('rejects a noncanonical server expectation and wrong approval kind', async () => {
    const proposed = propose();
    await expect(
      applySecretIntroduction({
        approvalId: proposed.approvalId,
        value: token,
        expected: { ...expected, secretKey: 'access_token' },
      })
    ).rejects.toThrow('must be canonical');
    rewrite(proposed.approvalId, { kind: 'channel-approval' });
    await expect(apply(proposed.approvalId)).rejects.toThrow('not a secret_mutation');
    expectNoWrites();
  });
  it.each([
    '',
    '   ',
    'first\nsecond',
    'first\rsecond',
    'first\0second',
    'x'.repeat(SECRET_INTRODUCTION_WEB_TOKEN_MAX_BYTES + 1),
    'é'.repeat(SECRET_INTRODUCTION_WEB_TOKEN_MAX_BYTES / 2 + 1),
  ])('rejects empty, multiline, NUL, or over-limit token %#', async (value) => {
    const proposed = propose();
    await expect(apply(proposed.approvalId, value)).rejects.toThrow(
      'bounded non-empty single line'
    );
    expectNoWrites();
  });
  it('allows exactly the Web UTF-8 byte limit', async () => {
    const proposed = propose();
    await expect(
      apply(proposed.approvalId, 'é'.repeat(SECRET_INTRODUCTION_WEB_TOKEN_MAX_BYTES / 2))
    ).resolves.toMatchObject({ status: 'applied' });
  });
  it('preserves older CLI grants without expiry while requiring any supplied expiry to be valid', async () => {
    const proposed = propose();
    rewrite(proposed.approvalId, { expiresAt: undefined });
    await expect(
      applySecretIntroduction({
        approvalId: proposed.approvalId,
        value: token,
        storageChannel: 'concierge',
      })
    ).resolves.toMatchObject({ status: 'applied' });
  });
});

describe('serialized, crash-fenced apply', () => {
  it('permits one write for concurrent calls against the same approval', async () => {
    const proposed = propose();
    const outcomes = await Promise.allSettled([
      apply(proposed.approvalId),
      apply(proposed.approvalId),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(storeSecret).toHaveBeenCalledTimes(1);
    expect(storeConnectionDocument).toHaveBeenCalledTimes(1);
  });
  it('serializes different approved requests for the same canonical service', async () => {
    let active = 0;
    let maxActive = 0;
    storeSecret.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(active, maxActive);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
    });
    const one = propose();
    const two = propose();
    await Promise.all([apply(one.approvalId), apply(two.approvalId)]);
    expect(storeSecret).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });
  it('does not replay a durable claim left by an interrupted process', async () => {
    const proposed = propose();
    const record = read(proposed.approvalId);
    approvalStore.claimApprovalApply('mission_controller', {
      channel: 'concierge',
      requestId: record.id,
      appliedBy: expected.principalId,
      expectedRecordHash: approvalStore.computeApprovalPayloadHash({ record }),
    });
    await expect(apply(proposed.approvalId)).rejects.toThrow(SECRET_INTRODUCTION_RECOVERY_REQUIRED);
    expectNoWrites();
  });
  it('starts no credential effect when claim fsync fails and fences later retries', async () => {
    const proposed = propose();
    const fsync = vi.spyOn(secureIo, 'safeFsyncFile').mockImplementationOnce(() => {
      throw new Error('mock claim fsync failure');
    });
    await expect(apply(proposed.approvalId)).rejects.toThrow(SECRET_INTRODUCTION_RECOVERY_REQUIRED);
    expectNoWrites();
    fsync.mockRestore();
    await expect(apply(proposed.approvalId)).rejects.toThrow(SECRET_INTRODUCTION_RECOVERY_REQUIRED);
    expectNoWrites();
  });
  it.each(['keychain', 'connection document'] as const)(
    'sanitizes %s failure and prevents a partial-write replay',
    async (store) => {
      const proposed = propose();
      const providerError = new Error('provider included ' + token);
      if (store === 'keychain') storeSecret.mockRejectedValueOnce(providerError);
      else
        storeConnectionDocument.mockImplementationOnce(() => {
          throw providerError;
        });
      await expect(apply(proposed.approvalId)).rejects.toThrow(
        SECRET_INTRODUCTION_RECOVERY_REQUIRED
      );
      const record = read(proposed.approvalId);
      expect(record.status).toBe('failed');
      expect(record.applyResult?.auditRef).toBe(
        'secret-introduction:storage-incomplete:recovery-required'
      );
      expect(JSON.stringify(record)).not.toContain(token);
      const events = secureIo.safeReadFile(
        approvalStore.approvalEventLogicalPath('concierge'),
        'utf8'
      );
      expect(events).not.toContain(token);
      await expect(apply(proposed.approvalId)).rejects.toThrow(
        SECRET_INTRODUCTION_RECOVERY_REQUIRED
      );
      expect(storeSecret).toHaveBeenCalledTimes(1);
    }
  );
  it('retains the claim when receipt persistence fails after both stores', async () => {
    const proposed = propose();
    const receipt = vi
      .spyOn(approvalStore, 'recordApprovalApplyResult')
      .mockImplementationOnce(() => {
        throw new Error('receipt included ' + token);
      });
    await expect(apply(proposed.approvalId)).rejects.toThrow(SECRET_INTRODUCTION_RECOVERY_REQUIRED);
    expect(storeSecret).toHaveBeenCalledTimes(1);
    expect(storeConnectionDocument).toHaveBeenCalledTimes(1);
    receipt.mockRestore();
    expect(read(proposed.approvalId).applyClaim).toBeDefined();
    await expect(apply(proposed.approvalId)).rejects.toThrow(SECRET_INTRODUCTION_RECOVERY_REQUIRED);
    expect(storeSecret).toHaveBeenCalledTimes(1);
  });
  it('does not overwrite a successful receipt when later audit recording fails', async () => {
    const proposed = propose();
    ledgerRecord.mockImplementationOnce(() => {
      throw new Error('audit included ' + token);
    });
    await expect(apply(proposed.approvalId)).rejects.toThrow(SECRET_INTRODUCTION_RECOVERY_REQUIRED);
    expect(read(proposed.approvalId).applyResult?.result).toBe('success');
    expect(read(proposed.approvalId).status).toBe('applied');
    await expect(apply(proposed.approvalId)).rejects.toThrow('already applied');
    expect(storeSecret).toHaveBeenCalledTimes(1);
  });
});
