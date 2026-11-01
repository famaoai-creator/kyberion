import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GLOBAL_LEDGER_PATH,
  LEDGER_SEGMENT_ARCHIVED_TYPE,
  LEDGER_SEGMENT_OPENED_TYPE,
  ledgerSegmentLastHash,
  listLedgerSegments,
  loadForScope,
  normalizeLedgerRecord,
  record,
  recordLedgerSegmentArchived,
  setLedgerRotationOptionsForTests,
  setLedgerScanOptionsForTests,
  TENANT_LEDGER_STORE_ROLE,
  TENANT_LEDGER_ROOT,
  tenantLedgerPath,
  verifyAllLedgerIntegrity,
  verifyIntegrity,
  verifyLedgerIntegrityDetailed,
} from './ledger.js';
import * as pathResolver from './path-resolver.js';
import { computeLedgerEntryHash, GENESIS_HASH } from './chain-integrity.js';
import { getFoundationIo } from './foundation/io.js';
import { readTextFile } from './foundation/text.js';
import { withExecutionContext } from './authority.js';
import { validateWritePermission } from './tier-guard.js';

/** Append an unkeyed (`sha256`) entry — what anyone can compute without the chain key. */
function appendUnkeyedEntry(ledgerPath: string, type: string): void {
  const lines = fs.existsSync(ledgerPath)
    ? fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  const parent = lines.length ? String(JSON.parse(lines[lines.length - 1]).hash) : GENESIS_HASH;
  const entry = {
    id: `forged-${lines.length + 1}`,
    timestamp: '2026-10-28T00:00:00.000Z',
    type,
    role: 'forger',
    mission_id: 'None',
    payload: {},
    parent_hash: parent,
    chain_alg: 'sha256',
  };
  const hash = computeLedgerEntryHash(entry, { alg: 'sha256' });
  fs.writeFileSync(ledgerPath, [...lines, JSON.stringify({ ...entry, hash })].join('\n') + '\n');
}

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

  it('flags an unkeyed entry after a keyed one as a chain downgrade', () => {
    record('KEYED_EVENT', { data: 'keyed' });
    appendUnkeyedEntry(LEDGER_FILE, 'REWRITTEN_TAIL');

    const report = verifyLedgerIntegrityDetailed();
    expect(report.ok).toBe(false);
    expect(report.unkeyed).toBe(1);
    expect(report.corrupted).toEqual(['line:2:chain_downgrade']);
  });

  it('accepts an unkeyed legacy prefix unless keyed entries are required', () => {
    appendUnkeyedEntry(LEDGER_FILE, 'LEGACY_1');
    appendUnkeyedEntry(LEDGER_FILE, 'LEGACY_2');
    record('KEYED_EVENT', { data: 'keyed' });

    const legacy = verifyLedgerIntegrityDetailed();
    expect(legacy).toMatchObject({ ok: true, total: 3, unkeyed: 2, corrupted: [] });

    const strict = verifyLedgerIntegrityDetailed(LEDGER_FILE, { requireKeyed: true });
    expect(strict.ok).toBe(false);
    expect(strict.corrupted).toEqual(['line:1:unkeyed_entry', 'line:2:unkeyed_entry']);
  });

  it('never accepts an unkeyed entry in a tenant partition', () => {
    const partition = tenantLedgerPath('confidential', 'client-a');
    fs.mkdirSync(path.dirname(partition), { recursive: true });
    // A fully rewritten partition: valid sha256 links, no keyed entry at all.
    appendUnkeyedEntry(partition, 'FORGED_1');
    appendUnkeyedEntry(partition, 'FORGED_2');

    const all = verifyAllLedgerIntegrity();
    const tenant = all.ledgers.find((entry) => entry.tenant_slug === 'client-a');
    expect(all.ok).toBe(false);
    expect(tenant).toMatchObject({ ok: false, unkeyed: 2 });
    expect(tenant?.corrupted).toEqual(['line:1:unkeyed_entry', 'line:2:unkeyed_entry']);
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
  describe('size-independent tail and verify (MSN-STORE-BOUNDS-20261101)', () => {
    afterEach(() => {
      setLedgerScanOptionsForTests({});
      vi.restoreAllMocks();
    });

    /** Whole-file reads fail as they would past the old 100MB cap. */
    function failWholeFileReadsOfLedger() {
      const io = getFoundationIo();
      const original = io.readFile.bind(io);
      return vi.spyOn(io, 'readFile').mockImplementation((filePath, options) => {
        if (path.resolve(filePath) === path.resolve(LEDGER_FILE)) {
          throw new Error('File too large: exceeds the 100MB read cap');
        }
        return original(filePath, options);
      });
    }

    it('chains and verifies a multi-chunk ledger without a whole-file read', () => {
      // 64-byte chunks: every entry spans several chunks, as a >cap file would.
      setLedgerScanOptionsForTests({ chunkBytes: 64 });
      const readFile = failWholeFileReadsOfLedger();
      const hashes = Array.from({ length: 5 }, (_, i) => record(`BIG_LEDGER_EVENT_${i}`, { i }));
      const lines = fs.readFileSync(LEDGER_FILE, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(5);
      expect(lines.map((line) => JSON.parse(line).parent_hash)).toEqual([
        GENESIS_HASH,
        ...hashes.slice(0, 4),
      ]);
      expect(verifyLedgerIntegrityDetailed()).toMatchObject({ ok: true, total: 5, corrupted: [] });
      expect(loadForScope({ scope_kind: 'system' })).toHaveLength(5);
      const ledgerReads = readFile.mock.calls.filter(
        ([filePath]) => path.resolve(filePath) === path.resolve(LEDGER_FILE)
      );
      expect(ledgerReads).toEqual([]);
      // The spy is live: a whole-file read of this ledger would have failed.
      expect(() => readTextFile(LEDGER_FILE)).toThrow('File too large');
    });

    it('fails with LEDGER_TAIL_UNREADABLE on a torn last line instead of forking', () => {
      setLedgerScanOptionsForTests({ chunkBytes: 32 });
      record('BEFORE_TORN', {});
      fs.appendFileSync(LEDGER_FILE, '{"id":"torn","hash":"abc');
      expect(() => record('AFTER_TORN', {})).toThrow('[LEDGER_TAIL_UNREADABLE]');
      // Nothing was glued onto the fragment.
      expect(fs.readFileSync(LEDGER_FILE, 'utf8').endsWith('"hash":"abc')).toBe(true);
    });

    it('reports a torn last line as a verify finding', () => {
      record('BEFORE_TORN', {});
      fs.appendFileSync(LEDGER_FILE, '{"id":"torn"');
      const report = verifyLedgerIntegrityDetailed();
      expect(report.ok).toBe(false);
      expect(report.corrupted).toEqual(['line:2:parse_error']);
    });

    it('reads the tail past trailing blank lines', () => {
      setLedgerScanOptionsForTests({ chunkBytes: 16 });
      const first = record('FIRST', {});
      fs.appendFileSync(LEDGER_FILE, '\n\n');
      record('SECOND', {});
      const lines = fs.readFileSync(LEDGER_FILE, 'utf8').split('\n').filter(Boolean);
      expect(JSON.parse(lines[1]).parent_hash).toBe(first);
    });
  });

  describe('hash-chained segment rotation (MSN-STORE-BOUNDS-3)', () => {
    const FIXED_NOW = new Date('2026-11-02T10:10:10.000Z');
    const STAMP = '20261102-101010';
    const ledgerDir = path.dirname(LEDGER_FILE);
    const rel = (file: string) =>
      path.relative(pathResolver.rootDir(), file).split(path.sep).join('/');
    type Entry = Record<string, unknown> & { hash: string; parent_hash: string; type: string };
    const readEntries = (file: string): Entry[] =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Entry);
    const removeSystemSegments = () => {
      for (const name of fs.readdirSync(ledgerDir)) {
        if (/^system-ledger-\d{8}-\d{6}(?:-\d+)?\.jsonl$/u.test(name)) {
          fs.rmSync(path.join(ledgerDir, name), { force: true });
        }
      }
    };

    beforeEach(() => {
      removeSystemSegments();
      // Every append crosses the threshold: one rotation per record.
      setLedgerRotationOptionsForTests({ maxBytes: 1, now: () => FIXED_NOW });
    });

    afterEach(() => {
      setLedgerRotationOptionsForTests({});
      removeSystemSegments();
    });

    it('rotates at the threshold into dated segments and keeps one chain across them', () => {
      const hashes = ['ROT_1', 'ROT_2', 'ROT_3'].map((type) => record(type, { type }));
      const segments = listLedgerSegments();
      expect(segments.map((file) => path.basename(file))).toEqual([
        `system-ledger-${STAMP}.jsonl`,
        `system-ledger-${STAMP}-1.jsonl`,
        `system-ledger-${STAMP}-2.jsonl`,
      ]);
      // The live file was renamed by the last append's rotation.
      expect(fs.existsSync(LEDGER_FILE)).toBe(false);

      const [first, second, third] = segments.map(readEntries);
      expect(first!.map((entry) => entry.type)).toEqual(['ROT_1']);
      expect(first![0]!.parent_hash).toBe(GENESIS_HASH);
      // Each later segment opens with a keyed marker continuing the previous one.
      expect(second!.map((entry) => entry.type)).toEqual([LEDGER_SEGMENT_OPENED_TYPE, 'ROT_2']);
      expect(second![0]).toMatchObject({
        parent_hash: hashes[0],
        payload: { previous_segment: path.basename(segments[0]!), previous_last_hash: hashes[0] },
      });
      expect(second![1]!.parent_hash).toBe(second![0]!.hash);
      expect(third![0]!.parent_hash).toBe(hashes[1]);
      expect(third![1]!.hash).toBe(hashes[2]);

      expect(verifyLedgerIntegrityDetailed()).toMatchObject({
        ok: true,
        total: 5,
        corrupted: [],
        segments: segments.map(rel),
      });
      expect(verifyIntegrity()).toBe(true);
      // A history reader sees every segment.
      expect(loadForScope({ scope_kind: 'system' }).map((entry) => entry.type)).toEqual([
        'ROT_1',
        LEDGER_SEGMENT_OPENED_TYPE,
        'ROT_2',
        LEDGER_SEGMENT_OPENED_TYPE,
        'ROT_3',
      ]);
    });

    it('orders collision suffixes numerically (-10 after -9)', () => {
      for (let i = 0; i < 12; i++) record(`MANY_${i}`, { i });
      const names = listLedgerSegments().map((file) => path.basename(file));
      expect(names.slice(9, 12)).toEqual([
        `system-ledger-${STAMP}-9.jsonl`,
        `system-ledger-${STAMP}-10.jsonl`,
        `system-ledger-${STAMP}-11.jsonl`,
      ]);
      expect(verifyLedgerIntegrityDetailed()).toMatchObject({ ok: true, total: 23 });
    });

    it('never stamps a segment before the newest one when the clock goes backward', () => {
      record('BEFORE_SKEW', {});
      setLedgerRotationOptionsForTests({
        maxBytes: 1,
        now: () => new Date('2026-11-01T00:00:00.000Z'),
      });
      record('AFTER_SKEW', {});
      expect(listLedgerSegments().map((file) => path.basename(file))).toEqual([
        `system-ledger-${STAMP}.jsonl`,
        `system-ledger-${STAMP}-1.jsonl`,
      ]);
      expect(verifyLedgerIntegrityDetailed().ok).toBe(true);
    });

    it('names the segment whose first entry does not link to the previous segment', () => {
      ['B_1', 'B_2', 'B_3'].forEach((type) => record(type, {}));
      const segments = listLedgerSegments();
      const second = readEntries(segments[1]!);
      second[0] = { ...second[0]!, parent_hash: 'f'.repeat(64) };
      fs.writeFileSync(
        segments[1]!,
        second.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
      );

      const report = verifyLedgerIntegrityDetailed();
      expect(report.ok).toBe(false);
      expect(report.corrupted).toContain(
        `segment_boundary:${rel(segments[1]!)}:parent_hash_mismatch:after:${rel(segments[0]!)}`
      );
    });

    it('detects a removed middle segment at the next boundary', () => {
      ['M_1', 'M_2', 'M_3'].forEach((type) => record(type, {}));
      const segments = listLedgerSegments();
      fs.rmSync(segments[1]!);
      const report = verifyLedgerIntegrityDetailed();
      expect(report.ok).toBe(false);
      expect(report.corrupted).toEqual(
        expect.arrayContaining([
          `segment_boundary:${rel(segments[2]!)}:marker_names:${path.basename(segments[1]!)}`,
          `segment_boundary:${rel(segments[2]!)}:parent_hash_mismatch:after:${rel(segments[0]!)}`,
        ])
      );
    });

    it('reports an unproven anchor when the oldest segment was deleted by hand', () => {
      ['A_1', 'A_2', 'A_3'].forEach((type) => record(type, {}));
      const segments = listLedgerSegments();
      fs.rmSync(segments[0]!);
      expect(verifyLedgerIntegrityDetailed()).toMatchObject({
        ok: false,
        anchoredFrom: path.basename(segments[0]!),
        corrupted: [
          `chain_start:${rel(segments[1]!)}:unproven_anchor:${path.basename(segments[0]!)}`,
        ],
      });

      // Dropping the marker leaves an unanchored start: it fails, naming the file.
      const third = readEntries(segments[2]!);
      fs.rmSync(segments[1]!);
      fs.writeFileSync(segments[2]!, JSON.stringify(third[1]) + '\n');
      const report = verifyLedgerIntegrityDetailed();
      expect(report.ok).toBe(false);
      expect(report.corrupted).toEqual([`chain_start:${rel(segments[2]!)}:parent_hash_mismatch`]);
    });

    it('reports an unproven anchor when every segment was deleted', () => {
      ['D_1', 'D_2'].forEach((type) => record(type, {}));
      setLedgerRotationOptionsForTests({ now: () => FIXED_NOW });
      record('D_LIVE', {});
      const segments = listLedgerSegments();
      segments.forEach((segment) => fs.rmSync(segment));
      const report = verifyLedgerIntegrityDetailed();
      expect(report.ok).toBe(false);
      expect(report.corrupted).toEqual([
        `chain_start:${rel(LEDGER_FILE)}:unproven_anchor:${path.basename(segments.at(-1)!)}`,
      ]);
    });

    it('verifies from the marker once the janitor archived the oldest segment with a receipt', () => {
      ['R_1', 'R_2'].forEach((type) => record(type, {}));
      setLedgerRotationOptionsForTests({ now: () => FIXED_NOW });
      const segments = listLedgerSegments();
      const lastHash = ledgerSegmentLastHash(segments[0]!);
      fs.rmSync(segments[0]!);
      recordLedgerSegmentArchived({
        segment: segments[0]!,
        last_hash: lastHash,
        archive_path: `active/archive/${path.basename(segments[0]!)}`,
      });
      expect(readEntries(LEDGER_FILE).map((entry) => entry.type)).toEqual([
        LEDGER_SEGMENT_OPENED_TYPE,
        LEDGER_SEGMENT_ARCHIVED_TYPE,
      ]);
      expect(verifyLedgerIntegrityDetailed()).toMatchObject({
        ok: true,
        corrupted: [],
        anchoredFrom: path.basename(segments[0]!),
      });
    });

    it('rejects an archive receipt whose last hash is not the anchor', () => {
      ['W_1', 'W_2'].forEach((type) => record(type, {}));
      setLedgerRotationOptionsForTests({ now: () => FIXED_NOW });
      const segments = listLedgerSegments();
      fs.rmSync(segments[0]!);
      recordLedgerSegmentArchived({
        segment: segments[0]!,
        last_hash: 'e'.repeat(64),
        archive_path: `active/archive/${path.basename(segments[0]!)}`,
      });
      expect(verifyLedgerIntegrityDetailed().corrupted).toEqual([
        `chain_start:${rel(segments[1]!)}:unproven_anchor:${path.basename(segments[0]!)}`,
      ]);
    });

    it('refuses chain-structure entry types through the generic record API', () => {
      expect(() => record('LEDGER_SEGMENT_ARCHIVED', { segment: 'x', last_hash: 'y' })).toThrow(
        /LEDGER_RESERVED_TYPE/
      );
      expect(() => record('LEDGER_SEGMENT_OPENED', {})).toThrow(/LEDGER_RESERVED_TYPE/);
    });

    it('refuses archive receipts for a tenant partition', () => {
      expect(() =>
        recordLedgerSegmentArchived(
          { segment: 'ledger-20261102-101010.jsonl', last_hash: 'a'.repeat(64), archive_path: 'x' },
          tenantLedgerPath('confidential', 'client-rot')
        )
      ).toThrow(/LEDGER_ARCHIVE_RECEIPT_REFUSED/u);
    });

    it('reports a tenant partition missing its oldest segment as an unproven anchor', () => {
      ['TA_1', 'TA_2', 'TA_3'].forEach((type) =>
        record(type, { tenant_slug: 'client-anchor', tier: 'confidential' })
      );
      const partition = tenantLedgerPath('confidential', 'client-anchor');
      const segments = withExecutionContext(
        TENANT_LEDGER_STORE_ROLE,
        () => listLedgerSegments(partition),
        undefined,
        'client-anchor'
      );
      fs.rmSync(segments[0]!);
      const tenant = verifyAllLedgerIntegrity().ledgers.find(
        (entry) => entry.tenant_slug === 'client-anchor'
      );
      expect(tenant).toMatchObject({
        ok: false,
        corrupted: [
          `chain_start:${rel(segments[1]!)}:unproven_anchor:${path.basename(segments[0]!)}`,
        ],
      });
    });

    it('never reuses a freed suffix that would sort before the newest segment', () => {
      ['F_1', 'F_2', 'F_3'].forEach((type) => record(type, {}));
      const before = listLedgerSegments();
      // The `-1` name is freed (e.g. archived); the next rotation must not reuse it.
      fs.rmSync(before[1]!);
      record('F_4', {});
      const names = listLedgerSegments().map((file) => path.basename(file));
      expect(names).toEqual([
        `system-ledger-${STAMP}.jsonl`,
        `system-ledger-${STAMP}-2.jsonl`,
        `system-ledger-${STAMP}-3.jsonl`,
      ]);
    });

    it('never rotates a mission evidence ledger', () => {
      const missionId = `MSN-LEDGER-NOROTATE-${process.pid}`;
      const missionDir = path.join(pathResolver.rootDir(), 'active/missions/public', missionId);
      const key = Symbol.for('kyberion.pathResolver.missionLocator');
      const globals = globalThis as Record<symbol, unknown>;
      const previous = globals[key];
      fs.mkdirSync(path.join(missionDir, 'evidence'), { recursive: true });
      pathResolver.registerMissionLocator((id) => (id === missionId ? missionDir : undefined));
      process.env.MISSION_ROLE = 'mission_controller';
      try {
        ['MR_1', 'MR_2', 'MR_3'].forEach((type) => record(type, { mission_id: missionId }));
        const missionLedger = path.join(missionDir, 'evidence/ledger.jsonl');
        expect(readEntries(missionLedger).map((entry) => entry.type)).toEqual([
          'MR_1',
          'MR_2',
          'MR_3',
        ]);
        expect(listLedgerSegments(missionLedger)).toEqual([]);
        // The system ledger's metadata entries still rotate.
        expect(listLedgerSegments()).toHaveLength(3);
      } finally {
        globals[key] = previous;
        fs.rmSync(missionDir, { recursive: true, force: true });
      }
    });

    it('chains from the newest segment when the live file is missing or empty after rotation', () => {
      const lastRotated = record('LIVE_GONE', {});
      expect(fs.existsSync(LEDGER_FILE)).toBe(false);
      // Stop rotating so the live file stays observable.
      setLedgerRotationOptionsForTests({ now: () => FIXED_NOW });

      // A concurrent writer created the live file empty in the gap.
      fs.writeFileSync(LEDGER_FILE, '\n');
      const next = record('AFTER_EMPTY_LIVE', {});
      const again = record('RIGHT_AFTER', {});
      const live = readEntries(LEDGER_FILE);
      expect(live.map((entry) => entry.type)).toEqual([
        LEDGER_SEGMENT_OPENED_TYPE,
        'AFTER_EMPTY_LIVE',
        'RIGHT_AFTER',
      ]);
      expect(live[0]!.parent_hash).toBe(lastRotated);
      expect(live[1]).toMatchObject({ parent_hash: live[0]!.hash, hash: next });
      expect(live[2]).toMatchObject({ parent_hash: next, hash: again });
      expect(verifyLedgerIntegrityDetailed()).toMatchObject({ ok: true, total: 4 });
    });

    it('never fails an append when rotation fails (warns, keeps the live file)', () => {
      setLedgerRotationOptionsForTests({ maxBytes: 1, now: () => new Date(Number.NaN) });
      const first = record('ROTATION_BROKEN_1', {});
      const second = record('ROTATION_BROKEN_2', {});
      expect(listLedgerSegments()).toEqual([]);
      expect(readEntries(LEDGER_FILE).map((entry) => entry.hash)).toEqual([first, second]);
      expect(verifyLedgerIntegrityDetailed().ok).toBe(true);
    });

    it('rotates a tenant partition as the tenant-bound store role', () => {
      const partition = tenantLedgerPath('confidential', 'client-rot');
      const segmentPath = path.join(path.dirname(partition), `ledger-${STAMP}.jsonl`);
      // The production role's write scope covers the live file and its segments.
      const scope = withExecutionContext(
        TENANT_LEDGER_STORE_ROLE,
        () => ({
          live: validateWritePermission(partition).allowed,
          segment: validateWritePermission(segmentPath).allowed,
        }),
        undefined,
        'client-rot'
      );
      expect(scope).toEqual({ live: true, segment: true });

      ['T_1', 'T_2', 'T_3'].forEach((type) =>
        record(type, { tenant_slug: 'client-rot', tier: 'confidential' })
      );
      const segments = withExecutionContext(
        TENANT_LEDGER_STORE_ROLE,
        () => listLedgerSegments(partition),
        undefined,
        'client-rot'
      );
      expect(segments.map((file) => path.basename(file))).toEqual([
        `ledger-${STAMP}.jsonl`,
        `ledger-${STAMP}-1.jsonl`,
        `ledger-${STAMP}-2.jsonl`,
      ]);
      expect(fs.existsSync(partition)).toBe(false);
      // Listed and verified across segments though the live file is gone.
      const all = verifyAllLedgerIntegrity();
      expect(all.ok).toBe(true);
      expect(all.ledgers.find((entry) => entry.tenant_slug === 'client-rot')).toMatchObject({
        ok: true,
        total: 5,
        segments: segments.map(rel),
      });
      expect(
        loadForScope({ tenant_slug: 'client-rot' })
          .map((entry) => entry.type)
          .filter((type) => type !== LEDGER_SEGMENT_OPENED_TYPE)
      ).toEqual(['T_1', 'T_2', 'T_3']);
      // The marker carries the tenant scope, never a system scope.
      expect(readEntries(segments[1]!)[0]!.scope).toMatchObject({ tenant_slug: 'client-rot' });
    });
  });
});
