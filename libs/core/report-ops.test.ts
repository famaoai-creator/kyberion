import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryPromotionCandidate } from './memory-promotion-queue.js';
import { runKnowledgeValidationSweep } from './report-ops.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

describe('runKnowledgeValidationSweep', () => {
  const root = pathResolver.sharedTmp(`knowledge-validation-sweep/${process.pid}`);
  const queuePath = `${root}/promotion-queue.jsonl`;
  const envKey = 'KYBERION_MEMORY_QUEUE_PATH';
  let originalQueuePath: string | undefined;

  beforeEach(() => {
    originalQueuePath = process.env[envKey];
    process.env[envKey] = queuePath;
    safeRmSync(root, { recursive: true, force: true });
    safeMkdir(root, { recursive: true });
  });

  afterEach(() => {
    safeRmSync(root, { recursive: true, force: true });
    if (originalQueuePath === undefined) delete process.env[envKey];
    else process.env[envKey] = originalQueuePath;
  });

  it('reports legacy records and only exposes the requested tenant', () => {
    const tenantCandidate = createMemoryPromotionCandidate({
      candidateId: 'MEM-TENANT-A',
      sourceType: 'incident',
      sourceRef: 'heuristic:tenant-a',
      proposedMemoryKind: 'heuristic',
      summary: 'tenant a lesson',
      evidenceRefs: ['knowledge/confidential/tenant-a/lesson.md'],
      sensitivityTier: 'confidential',
      scope: { tier: 'confidential', tenant_slug: 'tenant-a' },
    });
    const tenantB = createMemoryPromotionCandidate({
      candidateId: 'MEM-TENANT-B',
      sourceType: 'incident',
      sourceRef: 'heuristic:tenant-b',
      proposedMemoryKind: 'heuristic',
      summary: 'tenant b lesson',
      evidenceRefs: ['knowledge/confidential/tenant-b/lesson.md'],
      sensitivityTier: 'confidential',
      scope: { tier: 'confidential', tenant_slug: 'tenant-b' },
    });
    const legacy = createMemoryPromotionCandidate({
      candidateId: 'MEM-LEGACY',
      sourceType: 'incident',
      sourceRef: 'heuristic:legacy',
      proposedMemoryKind: 'heuristic',
      summary: 'legacy lesson',
      evidenceRefs: ['knowledge/product/legacy.md'],
      sensitivityTier: 'confidential',
    });
    safeWriteFile(
      queuePath,
      [tenantCandidate, tenantB, legacy].map(JSON.stringify).join('\n') + '\n'
    );

    const result = runKnowledgeValidationSweep({
      scope: { tier: 'confidential', tenant_slug: 'tenant-a' },
    });

    expect(result.status).toBe('ok');
    expect(result.promotion_queue.visible_count).toBe(1);
    expect(result.promotion_queue.scoped_count).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it('marks unscoped queue records as attention for an operator review', () => {
    const legacy = createMemoryPromotionCandidate({
      candidateId: 'MEM-LEGACY-ATTENTION',
      sourceType: 'incident',
      sourceRef: 'heuristic:legacy-attention',
      proposedMemoryKind: 'heuristic',
      summary: 'legacy lesson',
      evidenceRefs: ['knowledge/product/legacy.md'],
      sensitivityTier: 'confidential',
    });
    safeWriteFile(queuePath, `${JSON.stringify(legacy)}\n`);

    const result = runKnowledgeValidationSweep();

    expect(result.status).toBe('ok');
    expect(result.promotion_queue.legacy_unscoped_count).toBe(1);
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'legacy_unscoped_candidate',
        severity: 'warning',
      }),
    ]);
  });
});
