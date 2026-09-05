import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  loadForScope,
  normalizeLedgerRecord,
  record,
  verifyIntegrity,
  verifyLedgerIntegrityDetailed,
} from './ledger.js';

// We need to handle the hardcoded LEDGER_PATH in ledger.ts
const LEDGER_FILE = path.join(process.cwd(), 'active/audit/system-ledger.jsonl');

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
  });

  afterEach(() => {
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
