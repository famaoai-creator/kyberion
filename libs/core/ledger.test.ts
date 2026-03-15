import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { record, verifyIntegrity } from './ledger.js';

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
});
