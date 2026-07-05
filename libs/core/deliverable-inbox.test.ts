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
    const { addInboxEntry, listInboxEntries, markInboxEntry } =
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

    const accepted = markInboxEntry(entry.entry_id, 'accepted');
    expect(accepted?.status).toBe('accepted');

    const acceptedList = listInboxEntries({ status: 'accepted' });
    expect(acceptedList).toHaveLength(1);
    expect(acceptedList[0]?.entry_id).toBe(entry.entry_id);
  });
});
