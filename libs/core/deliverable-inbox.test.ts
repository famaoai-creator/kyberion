import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const secureIo = vi.hoisted(() => ({
  assertSafeRepositoryPath: (filePath: string) => {
    const root = path.resolve(process.env.KYBERION_ROOT || '');
    const resolved = path.resolve(filePath);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`[RESOURCE_PATH_SCOPE] ${filePath}`);
    }
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          throw new Error(`[RESOURCE_PATH_SYMLINK] ${filePath}`);
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') break;
        throw error;
      }
    }
    return resolved;
  },
  safeAppendFileSync: (filePath: string, data: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, data, 'utf8');
  },
  safeCreateExclusiveFileSync: (filePath: string, data: string | Buffer = '') => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  },
  safeExistsSync: (filePath: string) => fs.existsSync(filePath),
  safeLstat: (filePath: string) => fs.lstatSync(filePath),
  safeMkdir: (dirPath: string) => fs.mkdirSync(dirPath, { recursive: true }),
  safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
    options.encoding === null ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8'),
  loadJson: <T>(filePath: string): T => JSON.parse(fs.readFileSync(filePath, 'utf8')) as T,
  loadJsonIfPresent: <T>(filePath: string): T | null => {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
      return null;
    }
  },
  safeUnlinkSync: (filePath: string) => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },
  safeWriteFile: (filePath: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  },
}));

vi.mock('./secure-io.js', () => secureIo);
vi.mock('./foundation/io.js', () => ({
  getFoundationIo: () => ({
    loadJson: secureIo.loadJson,
    loadJsonIfPresent: secureIo.loadJsonIfPresent,
    appendFile: secureIo.safeAppendFileSync,
    exists: secureIo.safeExistsSync,
    readFile: (filePath: string) => String(secureIo.safeReadFile(filePath)),
    stat: () => ({ mtimeMs: 0, size: 0 }),
    writeFile: secureIo.safeWriteFile,
  }),
  registerFoundationIo: vi.fn(),
}));

describe('deliverable inbox', () => {
  let tmpRoot: string;

  // One fixture root and one module instance per file: path-resolver binds
  // KYBERION_ROOT and deliverable-inbox its INBOX_PATH at import time, so the
  // module is imported once, after the root is set, instead of
  // vi.resetModules() + re-import per test (operations-hygiene-runbook §5).
  // Per-test isolation is the wiped runtime tree in beforeEach.
  beforeAll(async () => {
    tmpRoot = path.join(os.tmpdir(), `kyberion-inbox-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    const schemaDir = path.join(tmpRoot, 'knowledge/product/schemas');
    fs.mkdirSync(schemaDir, { recursive: true });
    fs.copyFileSync(
      path.resolve('knowledge/product/schemas/deliverable-inbox-entry.schema.json'),
      path.join(schemaDir, 'deliverable-inbox-entry.schema.json')
    );
    process.env.KYBERION_ROOT = tmpRoot;
    await import('./deliverable-inbox.js');
  });

  beforeEach(() => {
    // Everything but the package.json marker and the copied schema.
    for (const entry of fs.readdirSync(tmpRoot)) {
      if (entry === 'package.json' || entry === 'knowledge') continue;
      fs.rmSync(path.join(tmpRoot, entry), { recursive: true, force: true });
    }
  });

  afterAll(() => {
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('rejects malformed inbox lock records', async () => {
    const { normalizeInboxLockRecord } = await import('./deliverable-inbox.js');
    expect(normalizeInboxLockRecord([])).toBeUndefined();
    expect(normalizeInboxLockRecord({ pid: '123' })).toBeUndefined();
    expect(normalizeInboxLockRecord({ pid: 1.5 })).toBeUndefined();
    expect(normalizeInboxLockRecord({ pid: process.pid })).toEqual({ pid: process.pid });
  });

  it('accepts only regular files as inbox lock resources', async () => {
    const { isRegularInboxLockPath } = await import('./deliverable-inbox.js');
    const lockPath = path.join(tmpRoot, 'active/shared/inbox/entries.jsonl.lock');
    const directoryPath = path.join(tmpRoot, 'active/shared/inbox/lock-directory');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
    fs.mkdirSync(directoryPath, { recursive: true });

    expect(isRegularInboxLockPath(lockPath)).toBe(true);
    expect(isRegularInboxLockPath(directoryPath)).toBe(false);
    expect(isRegularInboxLockPath(path.join(tmpRoot, 'missing.lock'))).toBe(false);
  });

  it('adds, lists, and marks inbox entries', async () => {
    const { acceptInboxEntryWithHumanReceipt, addInboxEntry, listInboxEntries, markInboxEntry } =
      await import('./deliverable-inbox.js');

    fs.mkdirSync(path.join(tmpRoot, 'active/shared/inbox'), { recursive: true });
    const entry = addInboxEntry({
      missionId: 'MSN-1',
      title: 'Deliverable ready',
      artifactPaths: ['active/missions/public/MSN-1/evidence/report.md'],
      summary: 'Report delivered',
      tenantSlug: 'tenant-a',
    });

    expect(entry.status).toBe('unread');
    expect(entry.tenant_slug).toBe('tenant-a');

    const unread = listInboxEntries({ status: 'unread' });
    expect(unread).toHaveLength(1);
    expect(unread[0]?.entry_id).toBe(entry.entry_id);

    const accepted = acceptInboxEntryWithHumanReceipt({
      entryId: entry.entry_id,
      actorId: 'human:operator',
      authenticated: true,
      authMethod: 'passkey',
      responsibilityStatement: 'I accept this deliverable.',
    });
    expect(accepted?.status).toBe('accepted');

    const acceptedList = listInboxEntries({ status: 'accepted' });
    expect(acceptedList).toHaveLength(1);
    expect(acceptedList[0]?.entry_id).toBe(entry.entry_id);
  });

  it('records review verdicts with a note and reviewer (SU-03)', async () => {
    const { addInboxEntry, listInboxEntries, markInboxEntry } =
      await import('./deliverable-inbox.js');

    fs.mkdirSync(path.join(tmpRoot, 'active/shared/inbox'), { recursive: true });
    const entry = addInboxEntry({
      missionId: 'MSN-2',
      title: 'Draft deck',
      artifactPaths: ['active/missions/public/MSN-2/evidence/deck.pptx'],
    });

    const changesRequested = markInboxEntry(entry.entry_id, 'changes_requested', {
      verdictNote: 'スライド3の数字を最新に更新してください',
      reviewedBy: 'chronos-localadmin',
    });
    expect(changesRequested?.status).toBe('changes_requested');
    expect(changesRequested?.verdict_note).toBe('スライド3の数字を最新に更新してください');
    expect(changesRequested?.reviewed_by).toBe('chronos-localadmin');

    const rejected = markInboxEntry(entry.entry_id, 'rejected', { verdictNote: '要件不一致' });
    expect(rejected?.status).toBe('rejected');

    const filtered = listInboxEntries({ status: ['rejected', 'changes_requested'] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.entry_id).toBe(entry.entry_id);
  });

  it('persists repo-relative artifact paths — never machine-absolute ones', async () => {
    const { addInboxEntry } = await import('./deliverable-inbox.js');

    fs.mkdirSync(path.join(tmpRoot, 'active/shared/inbox'), { recursive: true });
    const absolute = path.join(tmpRoot, 'active/missions/public/MSN-P/evidence/a.md');
    const entry = addInboxEntry({
      missionId: 'MSN-P',
      title: 'Portable paths',
      artifactPaths: [absolute, 'trace:run-1', 'active/missions/public/MSN-P/evidence/b.md'],
      roleSections: [
        { role: 'implementer', summary: 'wrote it', evidence_refs: [absolute, 'trace:run-1'] },
      ],
    });

    expect(entry.artifact_paths).toEqual([
      'active/missions/public/MSN-P/evidence/a.md',
      'trace:run-1',
      'active/missions/public/MSN-P/evidence/b.md',
    ]);
    // Role-section refs normalize the same way so the artifact binding survives.
    expect(entry.role_sections?.[0]?.evidence_refs).toEqual([
      'active/missions/public/MSN-P/evidence/a.md',
      'trace:run-1',
    ]);
  });

  it('repoints a finished mission\u2019s stored refs to the archive location', async () => {
    const { addInboxEntry, repointMissionInboxPaths, listInboxEntries } =
      await import('./deliverable-inbox.js');
    const relative = 'active/missions/public/MSN-R/evidence/closeout.md';
    addInboxEntry({
      missionId: 'MSN-R',
      title: 'Pre-move refs',
      artifactPaths: [relative, 'trace:run-2'],
      roleSections: [{ role: 'implementer', summary: 'wrote it', evidence_refs: [relative] }],
    });

    const rewritten = repointMissionInboxPaths(
      'MSN-R',
      'active/missions/public/MSN-R',
      'active/archive/missions/MSN-R'
    );
    expect(rewritten).toBe(1);

    const [stored] = listInboxEntries({ missionId: 'MSN-R' });
    expect(stored.artifact_paths).toEqual([
      'active/archive/missions/MSN-R/evidence/closeout.md',
      'trace:run-2',
    ]);
    expect(stored.role_sections?.[0]?.evidence_refs).toEqual([
      'active/archive/missions/MSN-R/evidence/closeout.md',
    ]);
  });

  it('normalizes legacy machine-absolute stored refs in place', async () => {
    const { normalizeStoredInboxPaths, listInboxEntries } = await import('./deliverable-inbox.js');
    const absolute = path.join(tmpRoot, 'active/missions/public/MSN-L/evidence/legacy.md');
    const legacy = {
      entry_id: 'INBOX-LEGACY',
      mission_id: 'MSN-L',
      title: 'Legacy absolute entry',
      artifact_paths: [absolute, 'trace:t-1'],
      summary: 'stored before repo-relative normalization',
      created_at: '2026-10-10T00:00:00Z',
      updated_at: '2026-10-10T00:00:00Z',
      status: 'unread',
      role_sections: [{ role: 'implementer', summary: 's', evidence_refs: [absolute] }],
    };
    const inboxDir = path.join(tmpRoot, 'active/shared/inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'entries.jsonl'), `${JSON.stringify(legacy)}\n`);

    expect(normalizeStoredInboxPaths()).toBe(1);
    const [stored] = listInboxEntries({ missionId: 'MSN-L' });
    expect(stored.artifact_paths).toEqual([
      'active/missions/public/MSN-L/evidence/legacy.md',
      'trace:t-1',
    ]);
    expect(stored.role_sections?.[0]?.evidence_refs).toEqual([
      'active/missions/public/MSN-L/evidence/legacy.md',
    ]);
    // Second run is a no-op — the store is already clean.
    expect(normalizeStoredInboxPaths()).toBe(0);
  });

  it('requires an authenticated human receipt for final acceptance', async () => {
    const { acceptInboxEntryWithHumanReceipt, addInboxEntry, finalizeAcceptedDeliverable } =
      await import('./deliverable-inbox.js');

    fs.mkdirSync(path.join(tmpRoot, 'active/shared/inbox'), { recursive: true });
    const entry = addInboxEntry({
      missionId: 'MSN-3',
      title: 'Accepted report',
      artifactPaths: ['active/missions/public/MSN-3/evidence/report.md'],
    });

    expect(() =>
      acceptInboxEntryWithHumanReceipt({
        entryId: entry.entry_id,
        actorId: 'human:operator',
        authenticated: false,
        authMethod: 'passkey',
        responsibilityStatement: 'I accept this report.',
      })
    ).toThrow(/authenticated human/);

    const accepted = acceptInboxEntryWithHumanReceipt({
      entryId: entry.entry_id,
      actorId: 'human:operator',
      authenticated: true,
      authMethod: 'passkey',
      responsibilityStatement: 'I accept this report and retain responsibility for its use.',
    });
    expect(accepted?.status).toBe('accepted');
    expect(accepted?.acceptance_receipt?.actor_type).toBe('human');
    expect(accepted?.acceptance_receipt?.artifact_digest).toMatch(/^[a-f0-9]{64}$/);

    const delivered = finalizeAcceptedDeliverable({
      entryId: entry.entry_id,
      actorId: 'human:operator',
      authenticated: true,
      authMethod: 'passkey',
      destination: 'customer:acme',
    });
    expect(delivered?.delivery_receipt?.destination).toBe('customer:acme');
    expect(delivered?.delivery_receipt?.artifact_digest).toBe(
      delivered?.acceptance_receipt?.artifact_digest
    );
  });

  it('rejects a symlinked inbox file before reading or writing', async () => {
    const { listInboxEntries } = await import('./deliverable-inbox.js');
    const inboxDir = path.join(tmpRoot, 'active/shared/inbox');
    const inboxPath = path.join(inboxDir, 'entries.jsonl');
    const targetPath = path.join(tmpRoot, 'outside-inbox.jsonl');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(targetPath, '{"entry_id":"outside"}\n');
    fs.symlinkSync(targetPath, inboxPath);

    try {
      expect(() => listInboxEntries()).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      fs.rmSync(inboxPath, { force: true });
      fs.rmSync(targetPath, { force: true });
    }
  });

  it('rejects schema-invalid persisted entries before listing or updating', async () => {
    const { listInboxEntries } = await import('./deliverable-inbox.js');
    const inboxDir = path.join(tmpRoot, 'active/shared/inbox');
    const inboxPath = path.join(inboxDir, 'entries.jsonl');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(
      inboxPath,
      `${JSON.stringify({
        entry_id: 'INBOX-INVALID',
        title: 'Invalid entry',
        artifact_paths: [],
        summary: 'missing timestamps and status',
      })}\n`
    );

    expect(() => listInboxEntries()).toThrow(/Invalid catalog deliverable-inbox-entry/);
  });

  it('rejects a directory at the inbox entries path', async () => {
    const { listInboxEntries } = await import('./deliverable-inbox.js');
    const inboxDir = path.join(tmpRoot, 'active/shared/inbox');
    fs.mkdirSync(path.join(inboxDir, 'entries.jsonl'), { recursive: true });

    expect(() => listInboxEntries()).toThrow(/entries must be a regular file/);
  });
});
