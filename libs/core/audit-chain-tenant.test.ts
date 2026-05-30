import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

let testRoot: string;

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
    safeMkdir: (p: string, opts: any) => actualFs.mkdirSync(p, opts),
    safeReadFile: (p: string, opts: any) => actualFs.readFileSync(p, opts),
  };
});

vi.mock('./audit-forwarder.js', () => ({
  getAuditForwarder: () => ({ name: 'stub', publish: async () => {} }),
}));

vi.mock('./core.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Reset the global singleton between tests
const GLOBAL_KEY = Symbol.for('@kyberion/audit-chain');

describe('audit-chain — tenant mirror', () => {
  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-audit-tenant-'));
    // Clear singleton
    delete (globalThis as any)[GLOBAL_KEY];
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    delete (globalThis as any)[GLOBAL_KEY];
  });

  it('writes to shared audit dir by default', async () => {
    const { auditChain } = await import('./audit-chain.js');
    auditChain.record({ agentId: 'test', action: 'test', operation: 'op', result: 'completed' });

    const sharedAuditDir = path.join(testRoot, 'active', 'shared', 'logs', 'audit');
    const files = fs.readdirSync(sharedAuditDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toMatch(/audit-\d{4}-\d{2}-\d{2}\.jsonl/);
  });

  it('mirrors to tenant directory when tenantSlug is present', async () => {
    const { auditChain } = await import('./audit-chain.js');
    auditChain.record({
      agentId: 'agent-1',
      action: 'login',
      operation: 'auth',
      result: 'allowed',
      tenantSlug: 'sbiss',
    });

    const tenantAuditDir = path.join(testRoot, 'customer', 'sbiss', 'logs', 'audit');
    expect(fs.existsSync(tenantAuditDir)).toBe(true);
    const files = fs.readdirSync(tenantAuditDir);
    expect(files.length).toBe(1);

    const entries = fs
      .readFileSync(path.join(tenantAuditDir, files[0]), 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));
    expect(entries[0].tenantSlug).toBe('sbiss');
    expect(entries[0].action).toBe('login');
  });

  it('does not create tenant directory when no tenantSlug', async () => {
    const { auditChain } = await import('./audit-chain.js');
    auditChain.record({ agentId: 'agent-2', action: 'op', operation: 'x', result: 'completed' });

    const customerDir = path.join(testRoot, 'customer');
    expect(fs.existsSync(customerDir)).toBe(false);
  });

  it('mirrors multiple entries for same tenant to same file', async () => {
    const { auditChain } = await import('./audit-chain.js');
    auditChain.record({ agentId: 'a', action: 'create', operation: 'x', result: 'completed', tenantSlug: 'sbiss' });
    auditChain.record({ agentId: 'a', action: 'update', operation: 'y', result: 'allowed', tenantSlug: 'sbiss' });

    const tenantAuditDir = path.join(testRoot, 'customer', 'sbiss', 'logs', 'audit');
    const files = fs.readdirSync(tenantAuditDir);
    expect(files).toHaveLength(1);

    const entries = fs
      .readFileSync(path.join(tenantAuditDir, files[0]), 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));
    expect(entries).toHaveLength(2);
  });

  it('mirrors to separate tenant directories for different tenants', async () => {
    const { auditChain } = await import('./audit-chain.js');
    auditChain.record({ agentId: 'a', action: 'op', operation: 'x', result: 'completed', tenantSlug: 'sbiss' });
    auditChain.record({ agentId: 'b', action: 'op', operation: 'y', result: 'completed', tenantSlug: 'sbijsm' });

    expect(fs.existsSync(path.join(testRoot, 'customer', 'sbiss', 'logs', 'audit'))).toBe(true);
    expect(fs.existsSync(path.join(testRoot, 'customer', 'sbijsm', 'logs', 'audit'))).toBe(true);
  });
});
