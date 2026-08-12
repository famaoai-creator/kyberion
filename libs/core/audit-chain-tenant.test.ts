import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

let testRoot: string;
const GLOBAL_KEY = Symbol.for('@kyberion/audit-chain');

async function loadFreshAuditChain(at: Date) {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  vi.resetModules();
  delete (globalThis as any)[GLOBAL_KEY];
  return import('./audit-chain.js');
}

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    rootDir: () => testRoot,
  },
  rootDir: () => testRoot,
}));

vi.mock('./secure-io.js', async () => {
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    safeAppendFileSync: (p: string, data: string) => {
      actualFs.mkdirSync(path.dirname(p), { recursive: true });
      actualFs.appendFileSync(p, data);
    },
    safeExistsSync: (p: string) => actualFs.existsSync(p),
    safeReaddir: (p: string) => actualFs.readdirSync(p),
    safeMkdir: (p: string, opts: any) => actualFs.mkdirSync(p, opts),
    safeReadFile: (p: string, opts: any) => actualFs.readFileSync(p, opts),
    safeCreateExclusiveFileSync: (p: string, data: string) => {
      actualFs.mkdirSync(path.dirname(p), { recursive: true });
      actualFs.writeFileSync(p, data, { flag: 'wx' });
    },
    safeUnlinkSync: (p: string) => {
      try {
        actualFs.unlinkSync(p);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
    safeWriteFile: (p: string, data: string) => {
      actualFs.mkdirSync(path.dirname(p), { recursive: true });
      actualFs.writeFileSync(p, data);
    },
  };
});

vi.mock('./audit-forwarder.js', () => ({
  getAuditForwarder: () => ({ name: 'stub', publish: async () => {} }),
}));

vi.mock('./core.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('audit-chain — tenant mirror', () => {
  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-audit-tenant-'));
    // EG-14: the mirror follows an existing stance overlay and never creates
    // one, so a tenant that is expected to be mirrored must have its
    // customer/{slug}/ directory provisioned first — the same thing
    // `pnpm customer:create` does in a real checkout.
    for (const slug of ['sbiss', 'sbijsm']) {
      fs.mkdirSync(path.join(testRoot, 'customer', slug), { recursive: true });
    }
    // Clear singleton
    delete (globalThis as any)[GLOBAL_KEY];
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    delete (globalThis as any)[GLOBAL_KEY];
    vi.useRealTimers();
  });

  it('writes to shared audit dir by default', async () => {
    const { auditChain } = await import('./audit-chain.js');
    auditChain.record({ agentId: 'test', action: 'test', operation: 'op', result: 'completed' });

    const sharedAuditDir = path.join(testRoot, 'active', 'shared', 'logs', 'audit');
    const files = fs.readdirSync(sharedAuditDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toMatch(/audit-\d{4}-\d{2}-\d{2}\.jsonl/);
  });

  it('does not create a stance overlay for a slug that has none (EG-14)', async () => {
    const { auditChain } = await import('./audit-chain.js');
    auditChain.record({
      agentId: 'agent-x',
      action: 'work_item.created',
      operation: 'create:whatever',
      result: 'completed',
      tenantSlug: 'not-provisioned',
    });

    // The whole recurring-drift class: mirroring used to mkdir -p the path, so
    // any audit entry carrying a novel slug materialised customer/{slug}/, which
    // later read back as if a tenant existed.
    expect(fs.existsSync(path.join(testRoot, 'customer', 'not-provisioned'))).toBe(false);
  });

  it('refuses to mirror under a tier name used as a slug (EG-14)', async () => {
    fs.mkdirSync(path.join(testRoot, 'customer', 'public'), { recursive: true });
    const { auditChain } = await import('./audit-chain.js');
    const recorded = auditChain.record({
      agentId: 'agent-x',
      action: 'work_item.created',
      operation: 'create:whatever',
      result: 'completed',
      tenantSlug: 'public',
    });

    // Even with the directory present, a tier name is not a tenant and must not
    // accumulate tenant-scoped audit records in either the mirror or master.
    expect(recorded.tenantSlug).toBeUndefined();
    expect(auditChain.loadAll().at(-1)?.tenantSlug).toBeUndefined();
    expect(fs.existsSync(path.join(testRoot, 'customer', 'public', 'logs', 'audit'))).toBe(false);
  });

  it('mirrors to tenant directory when tenantSlug is present', async () => {
    const { auditChain } = await import('./audit-chain.js');
    auditChain.record({
      agentId: 'agent-1',
      action: 'login',
      operation: 'auth',
      result: 'allowed',
      correlationId: 'corr-audit-001',
      tenantSlug: 'sbiss',
    });

    const tenantAuditDir = path.join(testRoot, 'customer', 'sbiss', 'logs', 'audit');
    expect(fs.existsSync(tenantAuditDir)).toBe(true);
    const files = fs.readdirSync(tenantAuditDir);
    expect(files.length).toBe(1);

    const entries = fs
      .readFileSync(path.join(tenantAuditDir, files[0]), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(entries[0].tenantSlug).toBe('sbiss');
    expect(entries[0].action).toBe('login');
    expect(entries[0].correlationId).toBe('corr-audit-001');
  });

  it('does not mirror when no tenantSlug', async () => {
    const { auditChain } = await import('./audit-chain.js');
    auditChain.record({ agentId: 'agent-2', action: 'op', operation: 'x', result: 'completed' });

    // The stance directories exist (provisioned in beforeEach), so the assertion
    // is about the mirror not being written — not about customer/ being absent.
    for (const slug of ['sbiss', 'sbijsm']) {
      expect(fs.existsSync(path.join(testRoot, 'customer', slug, 'logs', 'audit'))).toBe(false);
    }
  });

  it('mirrors multiple entries for same tenant to same file', async () => {
    const { auditChain } = await import('./audit-chain.js');
    auditChain.record({
      agentId: 'a',
      action: 'create',
      operation: 'x',
      result: 'completed',
      tenantSlug: 'sbiss',
    });
    auditChain.record({
      agentId: 'a',
      action: 'update',
      operation: 'y',
      result: 'allowed',
      tenantSlug: 'sbiss',
    });

    const tenantAuditDir = path.join(testRoot, 'customer', 'sbiss', 'logs', 'audit');
    const files = fs.readdirSync(tenantAuditDir);
    expect(files).toHaveLength(1);

    const entries = fs
      .readFileSync(path.join(tenantAuditDir, files[0]), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(entries).toHaveLength(2);
  });

  it('mirrors to separate tenant directories for different tenants', async () => {
    const { auditChain } = await import('./audit-chain.js');
    auditChain.record({
      agentId: 'a',
      action: 'op',
      operation: 'x',
      result: 'completed',
      tenantSlug: 'sbiss',
    });
    auditChain.record({
      agentId: 'b',
      action: 'op',
      operation: 'y',
      result: 'completed',
      tenantSlug: 'sbijsm',
    });

    expect(fs.existsSync(path.join(testRoot, 'customer', 'sbiss', 'logs', 'audit'))).toBe(true);
    expect(fs.existsSync(path.join(testRoot, 'customer', 'sbijsm', 'logs', 'audit'))).toBe(true);
  });

  it('seeds the next run from the last persisted hash across days', async () => {
    const firstRun = await loadFreshAuditChain(new Date('2026-07-01T10:00:00.000Z'));
    const first = firstRun.auditChain.record({
      agentId: 'agent-1',
      action: 'create',
      operation: 'op',
      result: 'completed',
    });

    const secondRun = await loadFreshAuditChain(new Date('2026-07-02T10:00:00.000Z'));
    const second = secondRun.auditChain.record({
      agentId: 'agent-2',
      action: 'continue',
      operation: 'op',
      result: 'completed',
    });

    expect(second.previousHash).toBe(first.currentHash);
    expect(secondRun.auditChain.verify()).toMatchObject({ valid: 2, total: 2 });
  });

  it('flags missing days between audit files', async () => {
    const firstRun = await loadFreshAuditChain(new Date('2026-07-01T10:00:00.000Z'));
    firstRun.auditChain.record({
      agentId: 'agent-1',
      action: 'day-one',
      operation: 'op',
      result: 'completed',
    });

    const secondRun = await loadFreshAuditChain(new Date('2026-07-03T10:00:00.000Z'));
    secondRun.auditChain.record({
      agentId: 'agent-2',
      action: 'day-three',
      operation: 'op',
      result: 'completed',
    });

    const result = secondRun.auditChain.verify();
    expect(result.total).toBe(2);
    expect(result.corrupted).toContain('audit-gap:2026-07-01->2026-07-03');
  });
});
