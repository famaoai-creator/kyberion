import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const secureIo = vi.hoisted(() => ({
  safeAppendFileSync: (filePath: string, data: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, data, 'utf8');
  },
  safeCreateExclusiveFileSync: (filePath: string, data: string | Buffer = '') => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  },
  safeExistsSync: (filePath: string) => fs.existsSync(filePath),
  safeMkdir: (dirPath: string) => fs.mkdirSync(dirPath, { recursive: true }),
  safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
    options.encoding === null ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8'),
  safeUnlinkSync: (filePath: string) => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },
  safeWriteFile: (filePath: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  },
}));

vi.mock('./secure-io.js', () => secureIo);

describe('deliverable inbox', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = path.join(os.tmpdir(), `kyberion-inbox-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    process.env.KYBERION_ROOT = tmpRoot;
  });

  afterEach(async () => {
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
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
});
