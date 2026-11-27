import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  listExecutionFeedbackCandidates,
  loadExecutionFeedbackStore,
} from './execution-feedback.js';
import { executionFeedbackScopeRoot } from './execution-feedback-candidates.js';
import { loadKnowledgeUsageAggregate } from './knowledge-feedback-loop.js';
import {
  captureSessionCorrection,
  citePromotedKnowledgeForSession,
  recallPromotedKnowledgeForSession,
} from './memory-loop-session.js';

const ROOT = pathResolver.sharedTmp(`memory-loop-session-${process.pid}`);
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge/product/evolution/patterns/generated');
const PROMOTED_REL =
  'knowledge/product/evolution/patterns/generated/mem-SESSION-TEST-2026_11_27.md';

const DELIVERY_DIR = pathResolver.sharedTmp(`memory-loop-session-delivery-${process.pid}`);
const USAGE_FILE = pathResolver.sharedTmp(`memory-loop-session-usage-${process.pid}/usage.json`);
const FEEDBACK_DIR = pathResolver.sharedTmp(`memory-loop-session-feedback-${process.pid}`);
const QUEUE_REL = `active/shared/tmp/memory-loop-session-queue-${process.pid}.jsonl`;

describe('memory-loop-session (CLI/MCP session facade)', () => {
  let prevDeliveryDir: string | undefined;
  let prevUsagePath: string | undefined;
  let prevFeedbackDir: string | undefined;
  let prevQueuePath: string | undefined;

  const syntheticScope = {
    tier: 'confidential' as const,
    tenant_slug: 'synthetic-session-corr',
  };

  beforeEach(() => {
    prevDeliveryDir = process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR;
    prevUsagePath = process.env.KYBERION_KNOWLEDGE_USAGE_PATH;
    prevFeedbackDir = process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR;
    prevQueuePath = process.env.KYBERION_MEMORY_QUEUE_PATH;
    process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR = DELIVERY_DIR;
    process.env.KYBERION_KNOWLEDGE_USAGE_PATH = USAGE_FILE;
    process.env.KYBERION_KNOWLEDGE_FEEDBACK_DIR = FEEDBACK_DIR;
    process.env.KYBERION_MEMORY_QUEUE_PATH = QUEUE_REL;

    safeRmSync(ROOT, { recursive: true, force: true });
    safeRmSync(DELIVERY_DIR, { recursive: true, force: true });
    safeRmSync(path.dirname(USAGE_FILE), { recursive: true, force: true });
    safeRmSync(FEEDBACK_DIR, { recursive: true, force: true });
    safeRmSync(pathResolver.rootResolve(QUEUE_REL), { force: true });
    safeRmSync(executionFeedbackScopeRoot(syntheticScope), { recursive: true, force: true });

    safeMkdir(KNOWLEDGE_DIR, { recursive: true });
    safeWriteFile(
      path.join(ROOT, PROMOTED_REL),
      [
        '---',
        'title: Session Loop Closure Checklist',
        'last_updated: 2026-11-27',
        'tags: [memory-loop, cli]',
        '---',
        '',
        'Always verify pre-PR checks and cite delivered promoted knowledge in CLI sessions.',
        '',
      ].join('\n'),
      { encoding: 'utf8' }
    );
  });

  afterEach(() => {
    const restore = (key: string, val: string | undefined) => {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    };
    restore('KYBERION_KNOWLEDGE_DELIVERY_DIR', prevDeliveryDir);
    restore('KYBERION_KNOWLEDGE_USAGE_PATH', prevUsagePath);
    restore('KYBERION_KNOWLEDGE_FEEDBACK_DIR', prevFeedbackDir);
    restore('KYBERION_MEMORY_QUEUE_PATH', prevQueuePath);

    safeRmSync(ROOT, { recursive: true, force: true });
    safeRmSync(DELIVERY_DIR, { recursive: true, force: true });
    safeRmSync(path.dirname(USAGE_FILE), { recursive: true, force: true });
    safeRmSync(FEEDBACK_DIR, { recursive: true, force: true });
    safeRmSync(pathResolver.rootResolve(QUEUE_REL), { force: true });
    safeRmSync(executionFeedbackScopeRoot(syntheticScope), { recursive: true, force: true });
  });

  it('validates session ids and rejects empty recall/cite inputs', async () => {
    await expect(
      recallPromotedKnowledgeForSession({ topic: 'closure', sessionId: '../bad' })
    ).rejects.toThrow('[MEMORY_LOOP_SESSION_INVALID]');
    await expect(
      recallPromotedKnowledgeForSession({ topic: '   ', sessionId: 'cli-1' })
    ).rejects.toThrow('[MEMORY_LOOP_TOPIC_REQUIRED]');
    expect(() => citePromotedKnowledgeForSession({ sessionId: 'cli-1', used: [] })).toThrow(
      '[MEMORY_LOOP_CITE_EMPTY]'
    );
  });

  it('records delivery on recall and usage on cite, rejecting undelivered paths', async () => {
    const recall = await recallPromotedKnowledgeForSession({
      topic: 'closure checklist cli',
      sessionId: 'cli-2026-11-27',
      rootDir: ROOT,
      recipientKind: 'cli_session',
    });
    expect(recall.mission_id).toBe('session:cli-2026-11-27');
    expect(recall.delivered_count).toBe(1);
    expect(recall.entries[0]?.path).toBe(PROMOTED_REL);
    expect(recall.delivery_record_path).toBeTruthy();

    expect(loadKnowledgeUsageAggregate()).toEqual([
      expect.objectContaining({
        document_path: PROMOTED_REL,
        delivered_count: 1,
        used_count: 0,
      }),
    ]);

    const undelivered = 'knowledge/product/evolution/patterns/generated/mem-NEVER-DELIVERED.md';
    const cite = citePromotedKnowledgeForSession({
      sessionId: 'cli-2026-11-27',
      used: [PROMOTED_REL, undelivered],
      resultId: 'cli-cite-1',
    });
    expect(cite.usage_updated).toBe(true);
    expect(cite.used_paths).toEqual([PROMOTED_REL]);
    expect(cite.rejected_used_paths).toEqual([undelivered]);

    expect(loadKnowledgeUsageAggregate()).toEqual([
      expect.objectContaining({
        document_path: PROMOTED_REL,
        delivered_count: 1,
        used_count: 1,
      }),
    ]);
  });

  it('requires scope, blocks secrets, and persists clean scoped corrections', () => {
    const missingScope = captureSessionCorrection({
      text: '次からは確認してから進めて',
      sessionId: 'cli-corr-1',
    });
    expect(missingScope.captured).toBe(false);
    expect(missingScope.reason).toBe('scope_required');

    const secretBlocked = captureSessionCorrection({
      text: 'Next time never log sk-1234567890abcdefghijklmnop in terminal output',
      sessionId: 'cli-corr-1',
      scope: syntheticScope,
    });
    expect(secretBlocked.captured).toBe(false);
    expect(secretBlocked.reason).toBe('sensitive_content_blocked');

    const ok = captureSessionCorrection({
      text: '今後は箇条書きで要点を先にまとめて',
      sessionId: 'cli-corr-1',
      scope: syntheticScope,
      surface: 'cli',
    });
    expect(ok.captured).toBe(true);
    expect(loadExecutionFeedbackStore(syntheticScope).entries).toHaveLength(1);
    expect(listExecutionFeedbackCandidates(syntheticScope)).toHaveLength(1);
  });
});
