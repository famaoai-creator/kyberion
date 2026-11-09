import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { safeAppendFileSync, safeExistsSync, safeMkdir, safeRmSync } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import * as path from 'node:path';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  listMemoryPromotionCandidates,
  memoryPromotionQueuePath,
} from './memory-promotion-queue.js';

// D8 / MEMORY_LOOP_CLOSURE M2: one candidate type with kind and lane, and
// tier + entity scope written at capture — rejected at registration otherwise.
const QUEUE = `active/shared/tmp/test-memory-capture-scope-${process.pid}.jsonl`;

describe('memory candidate capture scope (D8)', () => {
  const previous = process.env.KYBERION_MEMORY_QUEUE_PATH;
  beforeEach(() => {
    process.env.KYBERION_MEMORY_QUEUE_PATH = QUEUE;
    if (safeExistsSync(memoryPromotionQueuePath())) safeRmSync(memoryPromotionQueuePath());
  });
  afterEach(() => {
    if (safeExistsSync(memoryPromotionQueuePath())) safeRmSync(memoryPromotionQueuePath());
    if (previous === undefined) delete process.env.KYBERION_MEMORY_QUEUE_PATH;
    else process.env.KYBERION_MEMORY_QUEUE_PATH = previous;
  });

  const base = {
    sourceType: 'mission' as const,
    sourceRef: 'mission:MSN-CAPTURE-SCOPE',
    proposedMemoryKind: 'sop' as const,
    summary: 'Close missions through the governed controller.',
    evidenceRefs: ['active/missions/MSN-CAPTURE-SCOPE/evidence/ledger.jsonl'],
  };

  it('rejects a confidential candidate registered without scope', () => {
    const candidate = createMemoryPromotionCandidate({ ...base, sensitivityTier: 'confidential' });
    expect(() => enqueueMemoryPromotionCandidate(candidate)).toThrow(/MEMORY_SCOPE_REQUIRED/);
    expect(listMemoryPromotionCandidates()).toHaveLength(0);
  });

  it('rejects a personal candidate whose scope has no owner', () => {
    const candidate = createMemoryPromotionCandidate({
      ...base,
      sensitivityTier: 'personal',
      scope: { tier: 'personal' },
    });
    expect(() => enqueueMemoryPromotionCandidate(candidate)).toThrow(/MEMORY_SCOPE_REQUIRED/);
  });

  it('accepts a tenant-scoped candidate and writes kind and lane at capture', () => {
    const candidate = createMemoryPromotionCandidate({
      ...base,
      sensitivityTier: 'confidential',
      scope: {
        tier: 'confidential',
        tenant_slug: 'tenant-capture',
        mission_id: 'MSN-CAPTURE-SCOPE',
      },
    });
    enqueueMemoryPromotionCandidate(candidate);
    const [row] = listMemoryPromotionCandidates();
    expect(row).toMatchObject({
      kind: 'lesson',
      lane: 'steward',
      scope: { tier: 'confidential', tenant_slug: 'tenant-capture' },
    });
  });

  it('accepts a public candidate without an entity scope', () => {
    const candidate = createMemoryPromotionCandidate({
      ...base,
      kind: 'hint',
      proposedMemoryKind: 'clarification_prompt',
      sensitivityTier: 'public',
    });
    enqueueMemoryPromotionCandidate(candidate);
    expect(listMemoryPromotionCandidates()[0]).toMatchObject({ kind: 'hint', lane: 'auto' });
  });

  it('migrates a legacy row on load without inferring its scope', () => {
    const file = pathResolver.rootResolve(QUEUE);
    if (!safeExistsSync(path.dirname(file))) safeMkdir(path.dirname(file), { recursive: true });
    safeAppendFileSync(
      file,
      `${JSON.stringify({
        candidate_id: 'MEM-LEGACY-1',
        source_type: 'incident',
        source_ref: 'heuristic:H-1',
        proposed_memory_kind: 'heuristic',
        summary: 'Legacy heuristic row.',
        evidence_refs: ['knowledge/public/x.md'],
        sensitivity_tier: 'confidential',
        ratification_required: true,
        status: 'queued',
        queued_at: '2026-10-01T00:00:00.000Z',
      })}\n`
    );
    const [row] = listMemoryPromotionCandidates();
    expect(row).toMatchObject({ kind: 'heuristic', lane: 'steward' });
    expect(row?.scope).toBeUndefined();
  });
});
