import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// secure-io accepts logical (repo-relative) paths and resolves them itself —
// the mock must do the same against the hermetic KYBERION_ROOT, otherwise
// writes land in the real working directory.
const secureIo = vi.hoisted(() => {
  const abs = (filePath: string) =>
    path.isAbsolute(filePath) ? filePath : path.join(process.env.KYBERION_ROOT || '', filePath);
  return {
    safeAppendFileSync: (filePath: string, data: string) => {
      fs.mkdirSync(path.dirname(abs(filePath)), { recursive: true });
      fs.appendFileSync(abs(filePath), data, 'utf8');
    },
    safeExistsSync: (filePath: string) => fs.existsSync(abs(filePath)),
    safeMkdir: (dirPath: string) => fs.mkdirSync(abs(dirPath), { recursive: true }),
    safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
      options.encoding === null
        ? fs.readFileSync(abs(filePath))
        : fs.readFileSync(abs(filePath), 'utf8'),
    safeReaddir: (dirPath: string) =>
      fs.existsSync(abs(dirPath)) ? fs.readdirSync(abs(dirPath)) : [],
    safeWriteFile: (filePath: string, data: string | Buffer) => {
      fs.mkdirSync(path.dirname(abs(filePath)), { recursive: true });
      fs.writeFileSync(abs(filePath), data);
    },
  };
});

vi.mock('./secure-io.js', () => secureIo);

// The work-loop summary drags in the whole intent catalog + schema registry;
// it is irrelevant to reason capture, so stub it out.
vi.mock('./work-design.js', () => ({
  buildOrganizationWorkLoopSummary: () => undefined,
}));

describe('approval rejection reason capture (LC-10)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = path.join(os.tmpdir(), `kyberion-approval-reason-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    process.env.KYBERION_ROOT = tmpRoot;
  });

  afterEach(() => {
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it('persists note + reason_category into the approval event stream on rejection', async () => {
    const { createApprovalRequest, decideApprovalRequest, approvalEventLogicalPath } =
      await import('./approval-store.js');

    const created = createApprovalRequest('mission_controller', {
      channel: 'terminal',
      threadTs: 'ts-lc10',
      correlationId: 'corr-lc10',
      requestedBy: 'worker:test',
      draft: { title: 'test approval', summary: 'reject me with a reason' },
    });

    const decided = decideApprovalRequest('mission_controller', {
      channel: 'terminal',
      requestId: created.id,
      decision: 'rejected',
      decidedBy: 'human:test',
      note: '数値の根拠が古い四半期のものになっている',
      reasonCategory: 'incorrect_content',
    });

    expect(decided.status).toBe('rejected');

    const eventPath = path.join(tmpRoot, approvalEventLogicalPath('terminal'));
    const lines = fs
      .readFileSync(eventPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const rejectedEvent = lines.find((event) => event.event === 'rejected');
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent.note).toContain('古い四半期');
    expect(rejectedEvent.reason_category).toBe('incorrect_content');
  });

  it('annotates a rejection reason after the decision (bridge ask-why)', async () => {
    const {
      createApprovalRequest,
      decideApprovalRequest,
      annotateApprovalRejectionReason,
      approvalEventLogicalPath,
    } = await import('./approval-store.js');

    const created = createApprovalRequest('mission_controller', {
      channel: 'slack',
      threadTs: 'ts-askwhy',
      correlationId: 'corr-askwhy',
      requestedBy: 'worker:test',
      draft: { title: 'bridge approval', summary: 'reject via button, reason later' },
    });
    decideApprovalRequest('mission_controller', {
      channel: 'slack',
      requestId: created.id,
      decision: 'rejected',
      decidedBy: 'human:test',
    });

    const annotated = annotateApprovalRejectionReason('mission_controller', {
      channel: 'slack',
      requestId: created.id,
      reasonCategory: 'scope',
      annotatedBy: 'human:test',
    });
    expect(annotated.id).toBe(created.id);

    const eventPath = path.join(tmpRoot, approvalEventLogicalPath('slack'));
    const events = fs
      .readFileSync(eventPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const reasonEvent = events.find((event) => event.event === 'rejection_reason_captured');
    expect(reasonEvent).toBeDefined();
    expect(reasonEvent.reason_category).toBe('scope');
    expect(reasonEvent.annotated_by).toBe('human:test');
  });

  it('normalizes reason categories from loose input', async () => {
    const { normalizeRejectionReasonCategory } = await import('./rejection-reason.js');
    expect(normalizeRejectionReasonCategory('incorrect-content')).toBe('incorrect_content');
    expect(normalizeRejectionReasonCategory('WRONG DIRECTION')).toBe('wrong_direction');
    expect(normalizeRejectionReasonCategory('not-a-category')).toBeUndefined();
    expect(normalizeRejectionReasonCategory(42)).toBeUndefined();
  });
});
