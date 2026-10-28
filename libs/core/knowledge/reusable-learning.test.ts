import { randomUUID, createHash } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  distillCandidateRecordPath,
  loadDistillCandidateRecord,
} from './distill-candidate-registry.js';
import {
  planReusableLearning,
  prepareReusableLearning,
  queueReusableLearning,
  type PrepareReusableLearningInput,
} from './reusable-learning.js';
import { laneApprovesWithoutSteward } from './promotion-lanes.js';
import { loadMemoryPromotionCandidate } from './memory-promotion-queue.js';
import { reviewMemoryPromotionCandidate } from './memory-promotion-review.js';
import { promoteMemoryCandidateToKnowledge } from './memory-promotion-workflow.js';

const cleanup = new Set<string>();
const marker = () => `reuse-${randomUUID().slice(0, 8)}`;
function write(ref: string, content: string): string {
  const absolute = pathResolver.rootResolve(ref);
  withExecutionContext('ecosystem_architect', () => {
    safeMkdir(path.dirname(absolute), { recursive: true });
    safeWriteFile(absolute, content);
  });
  cleanup.add(absolute);
  return ref;
}
function input(
  overrides: Partial<PrepareReusableLearningInput> = {}
): PrepareReusableLearningInput {
  const key = marker();
  return {
    scope: { tier: 'public' },
    sourceRef: write(
      `active/shared/tmp/public/shared/${key}/material.md`,
      `# ${key}\n\nValidated steps for a fictional ${key} workflow.`
    ),
    title: key,
    intent: `Improve the fictional ${key} workflow`,
    destination: 'knowledge',
    reuseCondition: 'When the same fictional task is requested again',
    verificationCommand: 'pnpm check -- --scope pr',
    ...overrides,
  };
}
afterEach(() => {
  withExecutionContext('ecosystem_architect', () => {
    for (const ref of cleanup) safeRmSync(ref, { force: true, recursive: true });
  });
  cleanup.clear();
  vi.unstubAllEnvs();
});

describe('reuse-first learning intake', () => {
  it('prefers an existing asset, captures same-read base digest, and does not modify it', () => {
    const item = input();
    const target = `knowledge/product/orchestration/000-${item.title}.md`;
    const before = `# ${item.title}\n\n${item.intent}\n\nExisting procedure.`;
    write(target, before);
    const plan = planReusableLearning(item);
    expect(plan).toMatchObject({
      decision: 'extend_existing',
      destination: 'knowledge',
      target_ref: target,
      base_sha256: createHash('sha256').update(before).digest('hex'),
      approval_required: true,
    });
    expect(String(safeReadFile(pathResolver.rootResolve(target)))).toBe(before);
  });

  it('treats an identical asset and unsettled evidence as no_change without queueing', () => {
    const item = input();
    const text = String(safeReadFile(pathResolver.rootResolve(item.sourceRef)));
    write(`knowledge/product/orchestration/000-${item.title}.md`, text);
    expect(prepareReusableLearning(item)).toMatchObject({
      plan: { decision: 'no_change' },
      persisted: false,
    });
    expect(prepareReusableLearning({ ...item, destination: 'evidence' })).toMatchObject({
      plan: { decision: 'no_change', destination: 'evidence' },
      persisted: false,
    });
  });

  it('requires an explicit readable target for replacement and detects content changes in the next plan', () => {
    const item = input();
    const target = `knowledge/product/orchestration/000-${item.title}.md`;
    write(target, 'A different old procedure');
    const first = planReusableLearning({ ...item, replaceTarget: target });
    expect(first.decision).toBe('replace_existing');
    write(target, 'Human changed this procedure after planning');
    const next = planReusableLearning({ ...item, replaceTarget: target });
    expect(first.base_sha256).not.toBe(next.base_sha256);
    expect(() => planReusableLearning({ ...item, replaceTarget: item.sourceRef })).toThrow(
      'LEARNING_TARGET_SCOPE'
    );
  });

  it('queues an idempotent review proposal in the existing registry, not an executable asset', () => {
    const item = input({ destination: 'skill' });
    const first = prepareReusableLearning(item);
    const second = prepareReusableLearning(item);
    const repeatedSource = write(
      `active/shared/tmp/public/shared/${marker()}/same-material.md`,
      String(safeReadFile(pathResolver.rootResolve(item.sourceRef)))
    );
    const fromAnotherRun = prepareReusableLearning({ ...item, sourceRef: repeatedSource });
    const file = distillCandidateRecordPath(first.candidate!.candidate_id);
    cleanup.add(file);
    expect(second.candidate?.candidate_id).toBe(first.candidate?.candidate_id);
    expect(fromAnotherRun.candidate?.candidate_id).toBe(first.candidate?.candidate_id);
    expect(loadDistillCandidateRecord(first.candidate!.candidate_id)).toMatchObject({
      status: 'proposed',
      tier: 'public',
      metadata: {
        origin: 'learning_intake',
        learning_plan: { destination: 'skill', approval_required: true },
      },
    });
    expect(first.plan.next_steps.join('\n')).toContain('content-bound approval');
    expect(first.candidate?.promoted_ref).toBeUndefined();
    expect(laneApprovesWithoutSteward(first.candidate!, 100)).toMatchObject({
      lane: 'steward',
      approves: false,
    });
  });

  it('keeps dry run read-only and refuses private-to-public and sibling-entity sources before reading them', () => {
    const item = input({ destination: 'skill' });
    const result = prepareReusableLearning(item, { dryRun: true });
    expect(result.persisted).toBe(false);
    expect(loadDistillCandidateRecord(result.candidate!.candidate_id)).toBeNull();
    expect(() =>
      planReusableLearning({ ...item, sourceRef: 'knowledge/confidential/other-org/private.md' })
    ).toThrow('LEARNING_SOURCE_SCOPE');
    expect(() =>
      planReusableLearning({
        ...item,
        scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: 'org-a' },
        sourceRef: 'knowledge/confidential/acme/organizations/org-b/private.md',
      })
    ).toThrow('LEARNING_SOURCE_SCOPE');
    expect(() =>
      planReusableLearning({
        ...item,
        scope: { tier: 'confidential', tenant_slug: 'acme' },
        sourceRef: 'knowledge/confidential/acme/organizations/org-b/private.md',
      })
    ).toThrow('LEARNING_SOURCE_SCOPE');
  });

  it('never chooses a public patch target for a private source', () => {
    const tenant = marker();
    const key = marker();
    vi.stubEnv('KYBERION_TIER', 'confidential');
    vi.stubEnv('KYBERION_TENANT', tenant);
    const scope = { tier: 'confidential' as const, tenant_slug: tenant };
    const item = input({
      scope,
      title: key,
      intent: `Fictional ${key} workflow`,
      sourceRef: write(`knowledge/confidential/${tenant}/material.md`, `Private ${key} lesson`),
    });
    write(`knowledge/product/orchestration/000-${key}.md`, `Fictional ${key} workflow`);
    const plan = withExecutionContext('ecosystem_architect', () => planReusableLearning(item));
    expect(plan.target_ref).not.toContain('knowledge/product');
    expect(() =>
      withExecutionContext('ecosystem_architect', () =>
        planReusableLearning({
          ...item,
          replaceTarget: `knowledge/product/orchestration/000-${key}.md`,
        })
      )
    ).toThrow('LEARNING_TARGET_SCOPE');
  });

  it('routes run material to pipeline review and retains unverified status', () => {
    const item = input({ destination: 'pipeline' });
    const plan = planReusableLearning(item);
    expect(plan.next_steps.join('\n')).toContain('not execution proof');
    expect(plan.approval_required).toBe(true);
  });

  it('rejects scope-field erasure and another personal owner before reading', () => {
    const item = input();
    expect(() =>
      planReusableLearning({
        ...item,
        scope: {
          tier: 'public',
          organizationIds: ['private-org'],
        } as unknown as PrepareReusableLearningInput['scope'],
      })
    ).toThrow('Unknown scope fields');
    expect(() =>
      planReusableLearning({
        ...item,
        scope: { tier: 'personal', owner_nhi: 'nhi:owner-a' },
        sourceRef: 'active/personal/owners/other-owner/lesson.md',
      })
    ).toThrow('LEARNING_SOURCE_SCOPE');
  });

  it('hands a persisted plan to the real memory review queue without approval, and rechecks stale evidence', async () => {
    const queue = pathResolver.sharedTmp(`reusable-review-${randomUUID()}.jsonl`);
    vi.stubEnv('KYBERION_MEMORY_QUEUE_PATH', queue);
    // Exercise the real enqueue audit path (normally suppressed by NODE_ENV=test).
    vi.stubEnv('NODE_ENV', 'development');
    cleanup.add(queue);
    const item = input({ destination: 'skill' });
    const prepared = prepareReusableLearning(item);
    cleanup.add(distillCandidateRecordPath(prepared.candidate!.candidate_id));
    expect(prepared.plan.next_steps.join('\n')).toContain(
      `--queue --candidate ${prepared.candidate!.candidate_id}`
    );
    const preview = queueReusableLearning(prepared.candidate!.candidate_id, item.scope, {
      dryRun: true,
    });
    expect(preview.queued).toBe(false);
    expect(loadMemoryPromotionCandidate(preview.memory_candidate_id)).toBeNull();
    const handoff = queueReusableLearning(prepared.candidate!.candidate_id, item.scope);
    expect(
      queueReusableLearning(prepared.candidate!.candidate_id, item.scope).memory_candidate_id
    ).toBe(handoff.memory_candidate_id);
    const queued = loadMemoryPromotionCandidate(handoff.memory_candidate_id)!;
    expect(queued).toMatchObject({
      status: 'queued',
      knowledge_domain: 'unclassified',
      ratification_required: true,
    });
    expect(laneApprovesWithoutSteward(queued, 100)).toMatchObject({
      lane: 'steward',
      approves: false,
    });
    const review = reviewMemoryPromotionCandidate(handoff.memory_candidate_id)[0]!;
    expect(review.approval_required).toBe(true);
    expect(review.blockers.map((blocker) => blocker.code)).toEqual(['unclassified_domain']);
    expect(review.evidence).toEqual([
      expect.objectContaining({ ref: item.sourceRef, status: 'present' }),
    ]);
    expect(handoff.next_steps).toContain(
      `pnpm mission memory-review ${handoff.memory_candidate_id}`
    );
    write(item.sourceRef, 'Changed after queueing; the existing approval basis is stale.');
    expect(reviewMemoryPromotionCandidate(handoff.memory_candidate_id)[0]!.blockers).toContainEqual(
      expect.objectContaining({ code: 'stale_learning_source' })
    );
    await expect(
      promoteMemoryCandidateToKnowledge({ candidateId: handoff.memory_candidate_id })
    ).rejects.toThrow('LEARNING_LINK_STALE');
    expect(() => queueReusableLearning(prepared.candidate!.candidate_id, item.scope)).toThrow(
      'LEARNING_LINK_STALE'
    );
  });

  it('does not treat indentation-sensitive procedure changes as an identical asset', () => {
    const item = input();
    const target = `knowledge/product/orchestration/000-${item.title}.md`;
    write(target, '```python\nif ready:\n    publish()\n```');
    write(item.sourceRef, '```python\nif ready:\npublish()\n```');
    expect(planReusableLearning({ ...item, replaceTarget: target }).decision).toBe(
      'replace_existing'
    );
  });
});
