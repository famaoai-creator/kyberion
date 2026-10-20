import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditChain } from '../governance/audit-chain.js';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { safeExistsSync, safeReadFile, safeRmSync } from '../secure-io.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  listMemoryPromotionCandidates,
  loadMemoryPromotionCandidate,
  memoryPromotionQueuePath,
  updateMemoryPromotionCandidateStatus,
} from './memory-promotion-queue.js';
const cleanup = new Set<string>();
let originalOverride: string | undefined;
beforeEach(() => {
  originalOverride = process.env.KYBERION_MEMORY_QUEUE_PATH;
  delete process.env.KYBERION_MEMORY_QUEUE_PATH;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const file of cleanup) safeRmSync(file, { recursive: true, force: true });
  cleanup.clear();
  if (originalOverride === undefined) delete process.env.KYBERION_MEMORY_QUEUE_PATH;
  else process.env.KYBERION_MEMORY_QUEUE_PATH = originalOverride;
});
describe('owner-isolated promotion queue', () => {
  it('retains audit correlation without exporting private artifact source paths', () => {
    const sourceRef = 'knowledge/personal/private-project/private-artifact-name.md';
    const scope = { tier: 'personal', owner_nhi: 'nhi:' + randomUUID() } as const;
    const candidate = createMemoryPromotionCandidate({
      sourceType: 'artifact',
      sourceRef,
      proposedMemoryKind: 'heuristic',
      summary: 'Private source',
      evidenceRefs: [sourceRef],
      sensitivityTier: 'confidential',
      ratificationRequired: true,
      scope,
    });
    const record = vi
      .spyOn(auditChain, 'record')
      .mockReturnValue({ id: 'AUD-OWNER-REGRESSION' } as ReturnType<typeof auditChain.record>);
    vi.stubEnv('NODE_ENV', 'development');
    const file = enqueueMemoryPromotionCandidate(candidate);
    cleanup.add(path.dirname(path.dirname(file)));
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      action: 'knowledge_promotion_candidate',
      correlationId: candidate.candidate_id,
      metadata: { candidate_id: candidate.candidate_id },
    });
    expect(record.mock.calls[0][0].metadata).not.toHaveProperty('source_ref');
    expect(JSON.stringify(record.mock.calls[0][0])).not.toContain(sourceRef);
    expect(loadMemoryPromotionCandidate(candidate.candidate_id, scope)?.source_ref).toBe(sourceRef);
  });
  it('does not expose personal source through global or other owner reads even with confidential destination', () => {
    const scope = { tier: 'personal', owner_nhi: 'nhi:' + randomUUID() } as const;
    const candidate = createMemoryPromotionCandidate({
      sourceType: 'task_session',
      sourceRef: 'task_session:owner-regression',
      proposedMemoryKind: 'clarification_prompt',
      summary: 'Private owner feedback must remain private',
      evidenceRefs: ['task_session:owner-regression'],
      sensitivityTier: 'confidential',
      ratificationRequired: true,
      scope,
    });
    const globalPath = memoryPromotionQueuePath();
    const before = safeExistsSync(globalPath)
      ? String(safeReadFile(globalPath, { encoding: 'utf8' }))
      : null;
    process.env.KYBERION_MEMORY_QUEUE_PATH = globalPath;
    const file = enqueueMemoryPromotionCandidate(candidate);
    cleanup.add(path.dirname(path.dirname(file)));
    expect(file).toContain('/active/personal/owners/');
    expect(loadMemoryPromotionCandidate(candidate.candidate_id, scope)?.summary).toBe(
      candidate.summary
    );
    expect(loadMemoryPromotionCandidate(candidate.candidate_id)).toBeNull();
    expect(
      listMemoryPromotionCandidates().some((row) => row.candidate_id === candidate.candidate_id)
    ).toBe(false);
    expect(
      loadMemoryPromotionCandidate(candidate.candidate_id, { ...scope, owner_nhi: 'nhi:other' })
    ).toBeNull();
    expect(
      safeExistsSync(globalPath) ? String(safeReadFile(globalPath, { encoding: 'utf8' })) : null
    ).toBe(before);
    const ownerBytes = String(safeReadFile(file, { encoding: 'utf8' }));
    const otherScope = { ...scope, owner_nhi: 'nhi:' + randomUUID() };
    expect(() =>
      updateMemoryPromotionCandidateStatus({
        candidateId: candidate.candidate_id,
        status: 'rejected',
        scope,
        scopeUpdate: otherScope,
      })
    ).toThrow('MEMORY_SCOPE_MIGRATION_REQUIRED');
    expect(String(safeReadFile(file, { encoding: 'utf8' }))).toBe(ownerBytes);
    expect(safeExistsSync(memoryPromotionQueuePath(otherScope))).toBe(false);
    process.env.KYBERION_MEMORY_QUEUE_PATH = file;
    expect(() =>
      updateMemoryPromotionCandidateStatus({
        candidateId: candidate.candidate_id,
        status: 'rejected',
        scope,
        scopeUpdate: { tier: 'public' },
      })
    ).toThrow('MEMORY_SCOPE_MIGRATION_REQUIRED');
    expect(String(safeReadFile(file, { encoding: 'utf8' }))).toBe(ownerBytes);
    process.env.KYBERION_MEMORY_QUEUE_PATH = globalPath;
    expect(
      updateMemoryPromotionCandidateStatus({
        candidateId: candidate.candidate_id,
        status: 'rejected',
        scope,
        allMatching: true,
      })?.status
    ).toBe('rejected');
  });
  it('refuses ownerless personal queue before writing shared state', () => {
    const sharedPath = memoryPromotionQueuePath();
    const before = safeExistsSync(sharedPath)
      ? String(safeReadFile(sharedPath, { encoding: 'utf8' }))
      : null;
    expect(() => memoryPromotionQueuePath({ tier: 'personal' })).toThrow('explicit owner_nhi');
    const candidate = createMemoryPromotionCandidate({
      sourceType: 'task_session',
      sourceRef: 'task_session:ownerless',
      proposedMemoryKind: 'clarification_prompt',
      summary: 'Must not persist',
      evidenceRefs: ['task_session:ownerless'],
      sensitivityTier: 'confidential',
      ratificationRequired: true,
      scope: { tier: 'personal' },
    });
    expect(() => enqueueMemoryPromotionCandidate(candidate)).toThrow('explicit owner_nhi');
    expect(
      safeExistsSync(sharedPath) ? String(safeReadFile(sharedPath, { encoding: 'utf8' })) : null
    ).toBe(before);
  });
});
