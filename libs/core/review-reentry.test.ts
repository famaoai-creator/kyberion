import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// secure-io resolves logical paths itself; the mock mirrors that against the
// hermetic KYBERION_ROOT (same pattern as approval-rejection-reason.test.ts).
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

describe('review re-entry queue (LC-11)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = path.join(os.tmpdir(), `kyberion-review-reentry-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    process.env.KYBERION_ROOT = tmpRoot;
  });

  afterEach(() => {
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it('enqueue → listPending → markProcessed roundtrip', async () => {
    const {
      enqueueReviewReentryRequest,
      listPendingReviewReentryRequests,
      markReviewReentryProcessed,
    } = await import('./review-reentry.js');

    const request = enqueueReviewReentryRequest('mission_controller', {
      missionId: 'msn-lc11-demo',
      artifactId: 'report-q2',
      verdict: 'request-changes',
      comment: '第2四半期の数値を最新に差し替えてください',
      reasonCategory: 'incorrect_content',
      reviewer: 'human:test',
    });

    expect(request.mission_id).toBe('MSN-LC11-DEMO');
    expect(request.status).toBe('pending');

    const pending = listPendingReviewReentryRequests('msn-lc11-demo');
    expect(pending).toHaveLength(1);
    expect(pending[0].reason_category).toBe('incorrect_content');

    const processed = markReviewReentryProcessed(
      'mission_controller',
      'MSN-LC11-DEMO',
      request.request_id,
      ['goal-gap-r1-1', 'goal-gap-r1-1-review']
    );
    expect(processed?.status).toBe('processed');
    expect(processed?.gap_task_ids).toEqual(['goal-gap-r1-1', 'goal-gap-r1-1-review']);
    expect(listPendingReviewReentryRequests('MSN-LC11-DEMO')).toHaveLength(0);
  });

  it('persists a human-rejection learning hint on enqueue (LC-12)', async () => {
    const { enqueueReviewReentryRequest } = await import('./review-reentry.js');
    enqueueReviewReentryRequest('mission_controller', {
      missionId: 'MSN-LC12-DEMO',
      artifactId: 'summary-doc',
      verdict: 'reject',
      comment: '要点が依頼と噛み合っていない',
      reasonCategory: 'wrong_direction',
      reviewer: 'human:test',
    });

    const hintsDir = path.join(tmpRoot, 'active/shared/runtime/feedback-loop/hints');
    expect(fs.existsSync(hintsDir)).toBe(true);
    const hintFiles = fs.readdirSync(hintsDir);
    expect(hintFiles.length).toBeGreaterThan(0);
    const allHints = hintFiles.flatMap((file) =>
      JSON.parse(fs.readFileSync(path.join(hintsDir, file), 'utf8'))
    );
    const rejectionHint = allHints.find(
      (hint: any) => hint.topic === 'human-rejection:wrong_direction'
    );
    expect(rejectionHint).toBeDefined();
    expect(rejectionHint.hint).toContain('summary-doc');
    expect(rejectionHint.tags).toContain('human_rejection');
  });

  it('builds a gap brief carrying verdict, category guidance, and comment', async () => {
    const { enqueueReviewReentryRequest, buildReviewGapText } = await import('./review-reentry.js');
    const request = enqueueReviewReentryRequest('mission_controller', {
      missionId: 'MSN-LC11-DEMO',
      artifactId: 'deck-v1',
      verdict: 'reject',
      comment: '構成が依頼内容とずれている',
      reasonCategory: 'wrong_direction',
      reviewer: 'human:test',
    });
    const gap = buildReviewGapText(request);
    expect(gap).toContain('human review reject on deliverable deck-v1');
    expect(gap).toContain('[wrong_direction]');
    expect(gap).toContain('構成が依頼内容とずれている');
  });

  it('rejects unsafe mission ids and request ids', async () => {
    const { enqueueReviewReentryRequest, markReviewReentryProcessed } =
      await import('./review-reentry.js');
    expect(() =>
      enqueueReviewReentryRequest('mission_controller', {
        missionId: '../escape',
        artifactId: 'x',
        verdict: 'reject',
        reviewer: 'human:test',
      })
    ).toThrow('Invalid mission id');
    expect(() =>
      markReviewReentryProcessed('mission_controller', 'MSN-OK', '../escape', [])
    ).toThrow('Invalid review re-entry request id');
  });
});
