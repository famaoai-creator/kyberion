import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  tenant: 'tenant-a' as string | undefined,
  record: null as any,
  create: vi.fn(),
  usable: vi.fn(),
  audit: vi.fn(),
  consumed: false,
  mac: true,
  registry: vi.fn(),
  write: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
}));
vi.mock('./organization/tenant-registry.js', () => ({
  resolveTenant: (slug: string) => mocks.registry(slug),
}));
vi.mock('./secure-io.js', async (original) => ({
  ...(await original<typeof import('./secure-io.js')>()),
  safeWriteFile: (...args: unknown[]) => mocks.write(...args),
  safeMkdir: (...args: unknown[]) => mocks.mkdir(...args),
  safeRmSync: (...args: unknown[]) => mocks.rm(...args),
}));
vi.mock('./platform.js', async (original) => ({
  ...(await original<typeof import('./platform.js')>()),
  isMacOS: () => mocks.mac,
}));
vi.mock('./authority.js', async (original) => ({
  ...(await original<typeof import('./authority.js')>()),
  resolveIdentityContext: () => ({ tenantSlug: mocks.tenant }),
}));
vi.mock('./governance/approval-store.js', async (original) => ({
  ...(await original<typeof import('./governance/approval-store.js')>()),
  createApprovalRequest: (_role: unknown, params: unknown) => mocks.create(params),
  loadApprovalRequest: () => mocks.record,
}));
vi.mock('./governance/approval-separation-of-duties.js', async (original) => ({
  ...(await original<typeof import('./governance/approval-separation-of-duties.js')>()),
  assertApprovalUsable: (...args: unknown[]) => mocks.usable(...args),
}));
vi.mock('./governance/approval-revocation.js', () => ({
  consumeApprovalWithin: (
    _role: unknown,
    _params: unknown,
    run: (consume: () => unknown) => unknown
  ) => {
    if (mocks.consumed || mocks.record?.status !== 'approved') throw Error('approval unavailable');
    return run(() => {
      mocks.consumed = true;
      return mocks.record;
    });
  },
}));
vi.mock('./governance/audit-chain.js', async (original) => ({
  ...(await original<typeof import('./governance/audit-chain.js')>()),
  auditChain: { record: (value: unknown) => mocks.audit(value) },
}));
import {
  listAppleShortcuts,
  runAppleShortcut,
  setShortcutRunnerForTests,
} from './shortcut-bridge.js';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.KYBERION_APPLE_FM;
  mocks.tenant = 'tenant-a';
  mocks.consumed = false;
  mocks.mac = true;
  mocks.record = null;
  mocks.registry.mockImplementation(() => ({ profile: { status: 'active' } }));
  mocks.rm.mockImplementation(() => {});
  mocks.write.mockImplementation(() => {});
  mocks.mkdir.mockImplementation(() => {});
  mocks.usable.mockImplementation(() => {});
  mocks.create.mockImplementation((params) => {
    mocks.record = { ...params, id: 'APR-TEST', status: 'pending', scope: params.scope };
    return mocks.record;
  });
});
afterEach(() => {
  setShortcutRunnerForTests();
  delete process.env.KYBERION_APPLE_FM;
});
async function approve(name = 'Example', input?: string) {
  await runAppleShortcut({ name, ...(input !== undefined ? { input } : {}) });
  mocks.record = {
    ...mocks.record,
    status: 'approved',
    decidedBy: 'user:alice',
    decidedByType: 'human',
    authenticated: true,
    decidedAuthMethod: 'passkey',
  };
  return mocks.record;
}
describe('governed Apple Shortcuts bridge', () => {
  it('lists only through the fixed managed CLI argument list', async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: 'One\nTwo\n', stderr: '' }));
    setShortcutRunnerForTests(run);
    expect(await listAppleShortcuts()).toEqual({ available: true, names: ['One', 'Two'] });
    expect(run).toHaveBeenCalledWith(['list'], 15000);
  });
  it('returns a pending exact input human request without launching a shortcut', async () => {
    const run = vi.fn();
    setShortcutRunnerForTests(run);
    const result = await runAppleShortcut({ name: 'Example', input: 'Hello private world' });
    expect(result.status).toBe('approval_required');
    expect(run).not.toHaveBeenCalled();
    expect(mocks.record.accountability.finalDecision).toBe('human_only');
    expect(mocks.record.scope).toEqual({ tier: 'confidential', tenant_slug: 'tenant-a' });
    expect(mocks.record.draft.details).toContain('Hello private world');
    expect(mocks.record.expiresAt).toBeTruthy();
  });
  it('consumes once before launch, records receipt and refuses replay', async () => {
    await approve();
    const run = vi.fn(async () => {
      expect(mocks.consumed).toBe(true);
      return { ok: true, stdout: 'Done', stderr: '' };
    });
    setShortcutRunnerForTests(run);
    const result = await runAppleShortcut({ name: 'Example', approval_request_id: 'APR-TEST' });
    expect(result.status).toBe('completed');
    expect(run).toHaveBeenCalledWith(['run', 'Example'], 60000);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'completed',
        metadata: expect.objectContaining({ tenant_slug: 'tenant-a' }),
      })
    );
    await expect(
      runAppleShortcut({ name: 'Example', approval_request_id: 'APR-TEST' })
    ).rejects.toThrow('approval unavailable');
    expect(run).toHaveBeenCalledOnce();
  });
  it.each(['name', 'input', 'tenant', 'timeout', 'expiry', 'human', 'auth', 'revoked'] as const)(
    'refuses changed or unusable %s before execution',
    async (change) => {
      await approve();
      const run = vi.fn();
      setShortcutRunnerForTests(run);
      const args = {
        name: 'Example',
        approval_request_id: 'APR-TEST',
        input: undefined as string | undefined,
        timeout_ms: undefined as number | undefined,
      };
      if (change === 'name') args.name = 'Other';
      if (change === 'input') args.input = 'changed';
      if (change === 'tenant') mocks.tenant = 'tenant-b';
      if (change === 'timeout') args.timeout_ms = 1000;
      if (change === 'expiry') mocks.record.expiresAt = '2000-01-01T00:00:00Z';
      if (change === 'human') mocks.record.decidedByType = 'ai_agent';
      if (change === 'auth') mocks.record.authenticated = false;
      if (change === 'revoked')
        mocks.usable.mockImplementation(() => {
          throw Error('revoked');
        });
      await expect(runAppleShortcut(args)).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
      expect(mocks.consumed).toBe(false);
    }
  );
  it('stages exact approved input only in a private tenant file and preserves receipt on cleanup failure', async () => {
    await approve('Example', 'private text');
    mocks.rm.mockImplementation(() => {
      throw Error('cleanup failed');
    });
    const run = vi.fn(async () => ({ ok: true, stdout: 'Done', stderr: '' }));
    setShortcutRunnerForTests(run);
    const result = await runAppleShortcut({
      name: 'Example',
      input: 'private text',
      approval_request_id: 'APR-TEST',
    });
    expect(result.status).toBe('completed');
    expect(mocks.write).toHaveBeenCalledWith(
      expect.stringContaining('/active/shared/tmp/confidential/tenant-a/apple-shortcuts/'),
      'private text',
      { encoding: 'utf8', mode: 0o600 }
    );
    expect(mocks.mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true, mode: 0o700 });
    expect(mocks.rm).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ result: 'completed' }));
  });
  it('a failed launch retains consumption and writes failed receipt', async () => {
    await approve();
    setShortcutRunnerForTests(async () => {
      throw Error('launch failed');
    });
    const result = await runAppleShortcut({ name: 'Example', approval_request_id: 'APR-TEST' });
    expect(result.status).toBe('failed');
    expect(mocks.consumed).toBe(true);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ result: 'failed' }));
  });
  it('returns a named timed receipt without including the private shortcut name in audit metadata', async () => {
    await approve('Private shortcut');
    setShortcutRunnerForTests(async () => ({
      ok: true,
      stdout: 'Done',
      stderr: 'private diagnostic',
    }));
    const result = await runAppleShortcut({
      name: 'Private shortcut',
      approval_request_id: 'APR-TEST',
    });
    expect(result).toMatchObject({
      status: 'completed',
      receipt: { shortcut_name: 'Private shortcut', elapsed_ms: expect.any(Number) },
    });
    if (result.status !== 'completed') throw Error('expected completed');
    expect(result.receipt.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(mocks.audit.mock.calls[0][0].metadata).not.toHaveProperty('shortcut_name');
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('Private shortcut');
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('private diagnostic');
  });
  it.each([
    'SHORTCUT_TIMEOUT',
    'SHORTCUT_OUTPUT_LIMIT',
    'SHORTCUT_EXIT_FAILED',
    'SHORTCUT_LAUNCH_FAILED',
  ] as const)(
    'returns sanitized %s recovery without leaking stderr or reusing approval',
    async (error_code) => {
      await approve();
      const run = vi.fn(async () => ({
        ok: false,
        stdout: '',
        stderr: 'SECRET /private/input.txt',
        error_code,
      }));
      setShortcutRunnerForTests(run);
      const result = await runAppleShortcut({ name: 'Example', approval_request_id: 'APR-TEST' });
      expect(result).toMatchObject({
        status: 'failed',
        error_code,
        reason: expect.any(String),
        next_action: expect.stringContaining('new approval'),
        receipt: { shortcut_name: 'Example', success: false, elapsed_ms: expect.any(Number) },
      });
      expect(JSON.stringify(result)).not.toContain('SECRET');
      expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('/private/input.txt');
      expect(mocks.consumed).toBe(true);
      await expect(
        runAppleShortcut({ name: 'Example', approval_request_id: 'APR-TEST' })
      ).rejects.toThrow('approval unavailable');
      expect(run).toHaveBeenCalledOnce();
    }
  );
  it('reports private-input preparation failure without launching or exposing the filesystem error', async () => {
    await approve('Example', 'private text');
    mocks.write.mockImplementation(() => {
      throw Error('SECRET /private/input.txt');
    });
    const run = vi.fn();
    setShortcutRunnerForTests(run);
    const result = await runAppleShortcut({
      name: 'Example',
      input: 'private text',
      approval_request_id: 'APR-TEST',
    });
    expect(result).toMatchObject({
      status: 'failed',
      error_code: 'SHORTCUT_INPUT_PREPARATION_FAILED',
      next_action: expect.stringContaining('already consumed'),
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('private text');
    expect(run).not.toHaveBeenCalled();
    expect(mocks.consumed).toBe(true);
  });
  it('opt-out overrides native execution and platform readiness', async () => {
    process.env.KYBERION_APPLE_FM = '0';
    const run = vi.fn();
    setShortcutRunnerForTests(run);
    expect((await listAppleShortcuts()).available).toBe(false);
    expect((await runAppleShortcut({ name: 'Example' })).status).toBe('unavailable');
    expect(run).not.toHaveBeenCalled();
  });
  it('requires a bound tenant and rejects hidden shortcut name controls', async () => {
    mocks.tenant = undefined;
    expect((await listAppleShortcuts()).available).toBe(false);
    await expect(runAppleShortcut({ name: 'Example' })).rejects.toThrow('SCOPE_REQUIRED');
    mocks.tenant = 'tenant-a';
    await expect(runAppleShortcut({ name: 'Example\nOther' })).rejects.toThrow('INPUT_INVALID');
  });
});
