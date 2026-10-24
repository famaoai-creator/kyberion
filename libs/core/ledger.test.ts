import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GLOBAL_LEDGER_PATH,
  loadForScope,
  normalizeLedgerRecord,
  record,
  TENANT_LEDGER_ROOT,
  tenantLedgerPath,
  verifyAllLedgerIntegrity,
  verifyIntegrity,
  verifyLedgerIntegrityDetailed,
} from './ledger.js';
import * as pathResolver from './path-resolver.js';

// Under Vitest the ledger resolves into the vitest-live sandbox (path-resolver),
// never the operator's real active/audit/system-ledger.jsonl.
const LEDGER_FILE = GLOBAL_LEDGER_PATH;
// The tenant partitions are sandboxed the same way (VITEST_LIVE_SUBTREES).
const TENANT_LEDGER_DIR = pathResolver.resolve(TENANT_LEDGER_ROOT);

describe('ledger core', () => {
  let backupContent: string | null = null;
  let previousRole: string | undefined;

  beforeEach(() => {
    previousRole = process.env.MISSION_ROLE;
    process.env.MISSION_ROLE = 'ruthless_auditor';
    if (fs.existsSync(LEDGER_FILE)) {
      backupContent = fs.readFileSync(LEDGER_FILE, 'utf8');
    }
    if (!fs.existsSync(path.dirname(LEDGER_FILE))) {
      fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
    }
    fs.writeFileSync(LEDGER_FILE, '');
    fs.rmSync(TENANT_LEDGER_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(TENANT_LEDGER_DIR, { recursive: true, force: true });
    if (backupContent !== null) {
      fs.writeFileSync(LEDGER_FILE, backupContent);
    } else if (fs.existsSync(LEDGER_FILE)) {
      fs.unlinkSync(LEDGER_FILE);
    }
    if (previousRole === undefined) {
      delete process.env.MISSION_ROLE;
    } else {
      process.env.MISSION_ROLE = previousRole;
    }
  });

  it('should record an event and return a valid SHA-256 hash', () => {
    const hash = record('TEST_EVENT', { role: 'tester', data: 'foo' });
    expect(typeof hash).toBe('string');
    expect(hash).toHaveLength(64);

    const content = fs.readFileSync(LEDGER_FILE, 'utf8');
    expect(content).toContain('TEST_EVENT');
    expect(content).toContain('foo');
    expect(content).toContain('"chain_alg":"hmac-sha256"');
  });

  it('should maintain a valid integrity chain for multiple events', () => {
    record('EVENT_1', { data: 'first' });
    record('EVENT_2', { data: 'second' });

    const isValid = verifyIntegrity();
    expect(isValid).toBe(true);
  });

  it('should detect tampering in the ledger file', () => {
    record('SAFE_EVENT', { data: 'original' });

    const content = fs.readFileSync(LEDGER_FILE, 'utf8');
    const tampered = content.replace('original', 'tampered');
    fs.writeFileSync(LEDGER_FILE, tampered);

    const isValid = verifyIntegrity();
    expect(isValid).toBe(false);
  });

  it('should detect parent hash mismatch', () => {
    record('E1', { data: '1' });
    record('E2', { data: '2' });

    const lines = fs.readFileSync(LEDGER_FILE, 'utf8').trim().split('\n');
    const entry2 = JSON.parse(lines[1]);
    entry2.parent_hash = 'badhash';
    lines[1] = JSON.stringify(entry2);

    fs.writeFileSync(LEDGER_FILE, lines.join('\n') + '\n');

    expect(verifyIntegrity()).toBe(false);
  });

  it('returns detailed integrity findings', () => {
    record('SAFE_EVENT', { data: 'original' });

    const content = fs.readFileSync(LEDGER_FILE, 'utf8');
    fs.writeFileSync(LEDGER_FILE, content.replace('SAFE_EVENT', 'TAMPERED_EVENT'));

    const report = verifyLedgerIntegrityDetailed();
    expect(report.ok).toBe(false);
    expect(report.total).toBe(1);
    expect(report.corrupted[0]).toContain('line:1');
  });

  it('stores system/entity scope and filters tenant views fail-closed', () => {
    record('TENANT_EVENT', {
      tenant_slug: 'client-a',
      organization_id: 'org-a',
      mission_id: 'MSN-A',
      tier: 'confidential',
      data: 'tenant-only',
    });
    record('SYSTEM_EVENT', { data: 'system-wide' });

    const tenantEntries = loadForScope({ tenant_slug: 'client-a' });
    expect(tenantEntries).toHaveLength(1);
    expect(tenantEntries[0]?.scope).toMatchObject({
      scope_kind: 'mission',
      tenant_slug: 'client-a',
      organization_id: 'org-a',
    });
    expect(loadForScope({ tenant_slug: 'client-b' })).toHaveLength(0);
    expect(loadForScope({ scope_kind: 'system' })).toHaveLength(1);
  });

  it('never writes a tenant record to the system ledger (D9)', () => {
    expect(TENANT_LEDGER_DIR.startsWith(pathResolver.rootDir())).toBe(true);
    expect(TENANT_LEDGER_DIR).toContain('vitest-live');
    record('TENANT_CONFIG', { tenant_slug: 'client-a', tier: 'confidential', data: 'a' });
    // An unplaceable tier keeps the tenant (fails closed to confidential).
    record('TENANT_ODD_TIER', { tenant_slug: 'client-a', tier: 'secret', data: 'b' });
    record('PUBLIC_TENANT', { tenant_slug: 'client-c', tier: 'public', data: 'c' });
    record('SYSTEM_EVENT', { data: 'system-wide' });

    const system = fs.readFileSync(LEDGER_FILE, 'utf8');
    expect(system).toContain('SYSTEM_EVENT');
    expect(system).not.toContain('client-');

    const confidential = fs.readFileSync(tenantLedgerPath('confidential', 'client-a'), 'utf8');
    expect(confidential).toContain('TENANT_CONFIG');
    expect(confidential).toContain('TENANT_ODD_TIER');
    const publicTenant = fs.readFileSync(tenantLedgerPath('public', 'client-c'), 'utf8');
    expect(publicTenant).toContain('PUBLIC_TENANT');

    const all = verifyAllLedgerIntegrity();
    expect(all.ok).toBe(true);
    expect(all.ledgers.map((entry) => entry.tenant_slug ?? 'system').sort()).toEqual([
      'client-a',
      'client-c',
      'system',
    ]);
    // (TENANT_ODD_TIER's payload contradicts its stored scope, so the scoped
    // projection treats it as invalid — it is still on the chain above.)
    expect(loadForScope({ tenant_slugs: 'all' }).map((entry) => entry.type)).toEqual(
      expect.arrayContaining(['SYSTEM_EVENT', 'TENANT_CONFIG', 'PUBLIC_TENANT'])
    );
    expect(loadForScope({ tenant_slug: 'client-c' }).map((entry) => entry.type)).toEqual([
      'PUBLIC_TENANT',
    ]);
  });

  it('rejects a non-slug tenant ledger path', () => {
    expect(() => tenantLedgerPath('confidential', 'shared')).toThrow('LEDGER_TENANT_INVALID');
    expect(() => tenantLedgerPath('confidential', '../x')).toThrow('LEDGER_TENANT_INVALID');
  });

  it('rejects malformed persisted records before projection or verification', () => {
    expect(normalizeLedgerRecord(null)).toBeUndefined();
    expect(normalizeLedgerRecord([])).toBeUndefined();
    expect(normalizeLedgerRecord({ type: 42 })).toBeUndefined();
    expect(normalizeLedgerRecord({ scope: [] })).toBeUndefined();

    fs.writeFileSync(
      LEDGER_FILE,
      [
        JSON.stringify([]),
        JSON.stringify({ type: 'SYSTEM_EVENT', scope: [] }),
        JSON.stringify({ type: 'SYSTEM_EVENT', scope: { tier: 'public', scope_kind: 'system' } }),
      ].join('\n') + '\n'
    );

    expect(loadForScope({ scope_kind: 'system' })).toHaveLength(1);
    const report = verifyLedgerIntegrityDetailed();
    expect(report.ok).toBe(false);
    expect(report.corrupted).toEqual([
      'line:1:invalid_record',
      'line:2:invalid_record',
      'line:3:parent_hash_mismatch',
    ]);
  });

  it('fails closed when the ledger path is replaced by a directory', () => {
    fs.unlinkSync(LEDGER_FILE);
    fs.mkdirSync(LEDGER_FILE, { recursive: true });
    try {
      expect(() => record('DIRECTORY_LEDGER_EVENT', {})).toThrow('ledger must be a regular file');
      expect(() => verifyLedgerIntegrityDetailed()).toThrow('ledger must be a regular file');
      expect(() => loadForScope({ scope_kind: 'system' })).toThrow('ledger must be a regular file');
    } finally {
      fs.rmSync(LEDGER_FILE, { recursive: true, force: true });
    }
  });
});
