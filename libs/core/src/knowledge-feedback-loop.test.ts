import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import {
  knowledgeDeliveryLogDir,
  knowledgeUsageAggregatePath,
  loadKnowledgeUsageAggregate,
  recordKnowledgeDelivery,
  recordKnowledgeUsageFeedback,
} from './knowledge-feedback-loop.js';
import {
  listMemoryPromotionCandidates,
  memoryPromotionQueuePath,
} from '../memory-promotion-queue.js';

// Hermetic isolation: point the delivery log dir, the usage aggregate file,
// and the memory promotion queue at unique per-process tmp paths so this
// suite never touches (or races on) the real active/shared/runtime files —
// same convention as memory-promotion-queue.ts's KYBERION_MEMORY_QUEUE_PATH.
const suiteRoot = pathResolver.sharedTmp(`kp05-knowledge-feedback-loop-test/${process.pid}`);
const deliveryDirOverride = `${suiteRoot}/knowledge-delivery`;
const usagePathOverride = `${suiteRoot}/knowledge-usage/usage.json`;
const queuePathOverride = `${suiteRoot}/promotion-queue.jsonl`;

let originalDeliveryDir: string | undefined;
let originalUsagePath: string | undefined;
let originalQueuePath: string | undefined;

beforeEach(() => {
  originalDeliveryDir = process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR;
  originalUsagePath = process.env.KYBERION_KNOWLEDGE_USAGE_PATH;
  originalQueuePath = process.env.KYBERION_MEMORY_QUEUE_PATH;
  process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR = deliveryDirOverride;
  process.env.KYBERION_KNOWLEDGE_USAGE_PATH = usagePathOverride;
  process.env.KYBERION_MEMORY_QUEUE_PATH = queuePathOverride;
  safeRmSync(suiteRoot, { recursive: true, force: true });
  // enqueueMemoryPromotionCandidate only ensures the DEFAULT queue dir
  // exists, not an overridden one — pre-create the parent dir ourselves.
  safeMkdir(path.dirname(queuePathOverride), { recursive: true });
});

afterEach(() => {
  safeRmSync(suiteRoot, { recursive: true, force: true });
  if (originalDeliveryDir === undefined) delete process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR;
  else process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR = originalDeliveryDir;
  if (originalUsagePath === undefined) delete process.env.KYBERION_KNOWLEDGE_USAGE_PATH;
  else process.env.KYBERION_KNOWLEDGE_USAGE_PATH = originalUsagePath;
  if (originalQueuePath === undefined) delete process.env.KYBERION_MEMORY_QUEUE_PATH;
  else process.env.KYBERION_MEMORY_QUEUE_PATH = originalQueuePath;
});

describe('recordKnowledgeDelivery', () => {
  it('writes a delivery record and returns the delivered refs when hints are delivered', () => {
    const result = recordKnowledgeDelivery({
      missionId: 'MSN-KP05-DELIVERY',
      taskId: 'T1',
      teamRole: 'implementer',
      recipientKind: 'agent',
      refs: [
        { path: 'knowledge/product/architecture/foo.md', score: 0.42, title: 'Foo' },
        { path: 'knowledge/product/architecture/bar.md', score: 0.31 },
      ],
    });

    expect(result).toBeDefined();
    expect(result!.refs).toEqual([
      { path: 'knowledge/product/architecture/foo.md', score: 0.42, title: 'Foo' },
      { path: 'knowledge/product/architecture/bar.md', score: 0.31 },
    ]);
    expect(safeExistsSync(result!.deliveryRecordPath)).toBe(true);

    const raw = safeReadFile(result!.deliveryRecordPath, { encoding: 'utf8' }) as string;
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record).toMatchObject({
      mission_id: 'MSN-KP05-DELIVERY',
      task_id: 'T1',
      team_role: 'implementer',
      recipient_kind: 'agent',
    });
    expect(record.refs).toHaveLength(2);
    expect(typeof record.delivered_at).toBe('string');

    const aggregate = loadKnowledgeUsageAggregate();
    const fooEntry = aggregate.find(
      (e) => e.document_path === 'knowledge/product/architecture/foo.md'
    );
    expect(fooEntry).toMatchObject({
      delivered_count: 1,
      used_count: 0,
      not_used_count: 0,
      occurrences: 1,
    });
  });

  it('does not write anything and returns undefined when there are no refs to deliver', () => {
    const result = recordKnowledgeDelivery({ missionId: 'MSN-KP05-EMPTY', refs: [] });
    expect(result).toBeUndefined();
    expect(safeExistsSync(knowledgeDeliveryLogDir())).toBe(false);
    expect(safeExistsSync(knowledgeUsageAggregatePath())).toBe(false);
  });

  it('deduplicates refs by path within one delivery call', () => {
    const result = recordKnowledgeDelivery({
      missionId: 'MSN-KP05-DEDUPE',
      refs: [
        { path: 'knowledge/product/foo.md', score: 0.1 },
        { path: 'knowledge/product/foo.md', score: 0.9 },
      ],
    });
    expect(result!.refs).toHaveLength(1);
    expect(result!.refs[0]?.score).toBe(0.1);
  });
});

describe('recordKnowledgeUsageFeedback', () => {
  it('is a no-op when feedback is absent — old-format task_result regression', () => {
    const result = recordKnowledgeUsageFeedback({
      missionId: 'MSN-KP05-NOFEEDBACK',
      taskId: 'T1',
      feedback: undefined,
    });
    expect(result).toEqual({ usageUpdated: false, promotionCandidateIds: [] });
    expect(safeExistsSync(knowledgeUsageAggregatePath())).toBe(false);
    expect(listMemoryPromotionCandidates()).toEqual([]);
  });

  it('updates delivered vs used aggregate counts for used and not_used paths', () => {
    recordKnowledgeDelivery({
      missionId: 'MSN-KP05-USAGE',
      taskId: 'T1',
      refs: [{ path: 'knowledge/product/foo.md' }, { path: 'knowledge/product/bar.md' }],
    });

    const result = recordKnowledgeUsageFeedback({
      missionId: 'MSN-KP05-USAGE',
      taskId: 'T1',
      feedback: { used: ['knowledge/product/foo.md'], not_used: ['knowledge/product/bar.md'] },
    });
    expect(result.usageUpdated).toBe(true);

    const aggregate = loadKnowledgeUsageAggregate();
    const foo = aggregate.find((e) => e.document_path === 'knowledge/product/foo.md');
    const bar = aggregate.find((e) => e.document_path === 'knowledge/product/bar.md');
    expect(foo).toMatchObject({
      delivered_count: 1,
      used_count: 1,
      not_used_count: 0,
      occurrences: 2,
    });
    expect(bar).toMatchObject({
      delivered_count: 1,
      used_count: 0,
      not_used_count: 1,
      occurrences: 2,
    });
  });

  it('enqueues missing_topics as knowledge-gap promotion candidates', () => {
    const result = recordKnowledgeUsageFeedback({
      missionId: 'MSN-KP05-GAP',
      taskId: 'T2',
      feedback: { missing_topics: ['how to configure the widget exporter'] },
    });

    expect(result.promotionCandidateIds).toHaveLength(1);
    const rows = listMemoryPromotionCandidates();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_type: 'task_session',
      source_ref: 'mission:MSN-KP05-GAP:task:T2',
      proposed_memory_kind: 'clarification_prompt',
      sensitivity_tier: 'confidential',
      status: 'queued',
    });
    expect(rows[0]?.summary).toContain('how to configure the widget exporter');
    expect(safeExistsSync(memoryPromotionQueuePath())).toBe(true);
  });

  it('treats a path listed in both used and not_used as used only', () => {
    const result = recordKnowledgeUsageFeedback({
      missionId: 'MSN-KP05-CONFLICT',
      taskId: 'T3',
      feedback: {
        used: ['knowledge/product/foo.md'],
        not_used: ['knowledge/product/foo.md'],
      },
    });
    expect(result.usageUpdated).toBe(true);
    const aggregate = loadKnowledgeUsageAggregate();
    const foo = aggregate.find((e) => e.document_path === 'knowledge/product/foo.md');
    expect(foo).toMatchObject({ used_count: 1, not_used_count: 0 });
  });
});
