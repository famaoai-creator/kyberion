import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { safeReadFile, safeRmSync } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { createWorkItemIfAbsent } from '../workforce/work-coordination.js';
import { WORK_COORDINATION_ROOT_PATH } from '../foundation/runtime-state-roots.js';
import { dotWorkItemInput, restoreDotWorkItemBody } from './dot-work-item.js';
import { appendActionRecord, dotProposalHash, type DotActionRecord } from './dot-action-ledger.js';
import { genericDotActionIdentity, dotAdmissionItemId } from './dot-admission-identity.js';
import { executeDotWorkItem, type DotExecutorPorts, type DotExecutorDeps } from './dot-executor.js';
import { dotStatePath } from './dot-state-paths.js';
import type { DotCharter } from './dot-charter.js';
import type { DotProposal } from './dot-proposals.js';
import { frontDeskExecutionProposal } from '../surface/front-desk-execution-proposal.js';

const roots = new Set<string>();
const oldOwner = process.env.KYBERION_NHI_ID;
afterEach(() => {
  for (const root of roots) safeRmSync(root, { recursive: true, force: true });
  roots.clear();
  if (oldOwner === undefined) delete process.env.KYBERION_NHI_ID;
  else process.env.KYBERION_NHI_ID = oldOwner;
});
function fixture(handoff = false) {
  const rootDir = 'active/shared/tmp/private-dot-work-' + randomUUID();
  roots.add(rootDir);
  const scope = { tier: 'personal' as const, owner_nhi: 'user:private-fixture' };
  process.env.KYBERION_NHI_ID = scope.owner_nhi;
  const source = {
    dot_id: 'private-source',
    status: 'active',
    title: 'Private source title',
    purpose: 'Private purpose',
    scope,
    goal: { statement: 'Private goal', budget: { wall_clock_ms_per_wake: 1000 } },
    authority: {
      authority_role: 'worker',
      allowed_execution_shapes: ['direct_reply', 'pipeline'],
      allowed_pipelines: ['pipelines/ok.json'],
    },
    attention: { triggers: [] },
    runtime: { heartbeat_id: 'private-source' },
  } as unknown as DotCharter;
  const executor = handoff
    ? {
        ...source,
        dot_id: 'private-recipient',
        authority: { ...source.authority, authority_role: 'ecosystem_architect' },
      }
    : source;
  const proposal: DotProposal = {
    action_id: handoff ? 'dot_handoff' : 'dot_delegate_work',
    title: 'SECRET TITLE',
    objective: 'SECRET OBJECTIVE',
    rationale: 'SECRET RATIONALE',
    intent: 'SECRET INTENT',
    expected_effect: { signal: 'SECRET SIGNAL', direction: 'increase' },
    target: 'resource:synthetic',
    execution_shape: 'direct_reply',
    ...(handoff ? { handoff_to: executor.dot_id } : {}),
  };
  const identity = genericDotActionIdentity(source, proposal, 0, 'private-test');
  const record: DotActionRecord = {
    ...proposal,
    ...identity,
    scope,
    dot_id: source.dot_id,
    actor_id: 'dot:' + source.dot_id,
    status: 'dispatched',
    proposal_hash: dotProposalHash(source.dot_id, proposal),
    work_item_id: dotAdmissionItemId(identity.action_ref),
    at: '2026-11-15T00:00:00Z',
  };
  appendActionRecord(record, { rootDir });
  const input = dotWorkItemInput(source, record, rootDir, undefined, executor);
  const item = createWorkItemIfAbsent(input);
  const runGoalTurn = vi.fn(async () => ({
    finalState: 'complete',
    turnsRun: 1,
    finalText: 'complete',
    goal: { budgetStats: { tokensUsed: 1 } },
  }));
  const ports = {
    runGoalTurn,
    delegateText: vi.fn(),
    runPipeline: vi.fn(),
  } as unknown as DotExecutorPorts;
  const claim = vi.fn(() => ({
    item: { ...item, status: 'in_progress', current_attempt_id: 'attempt', lease_id: 'lease' },
    lease: { lease_id: 'lease' },
  }));
  const deps = {
    rootDir,
    claim,
    release: vi.fn(() => ({ item, lease: {} })),
    renew: vi.fn(),
    audit: vi.fn(),
    appendInbox: vi.fn(),
    recordTokens: vi.fn(),
    now: () => new Date('2026-11-15T00:00:00Z'),
  } as unknown as DotExecutorDeps;
  return {
    rootDir,
    source,
    executor,
    proposal,
    record,
    input,
    item,
    ports,
    runGoalTurn,
    claim,
    deps,
  };
}

describe('private Dot executable body', () => {
  it('keeps the public frontdesk exception reference-only without minting generic admission', () => {
    const binding = {
      mapping_id: 'receipt-fixture',
      config_digest: 'a'.repeat(64),
      conversation_key: 'b'.repeat(64),
      request_id: '00000000-0000-4000-8000-000000000001',
      revision: 1,
      request_digest: 'c'.repeat(64),
      work_item_id: 'WI-FD-' + 'd'.repeat(48),
    };
    const canonical = frontDeskExecutionProposal(binding);
    const charter = {
      dot_id: 'frontdesk-fixture',
      title: 'SECRET CHARTER',
      scope: { tier: 'public', tenant_slug: 'synthetic' },
      authority: { authority_role: 'worker' },
      goal: { statement: 'SECRET GOAL' },
    } as DotCharter;
    const row = {
      ...canonical,
      action_ref: 'frontdesk-' + binding.work_item_id,
      title: 'SECRET TITLE',
      objective: 'SECRET OBJECTIVE',
      rationale: 'SECRET RATIONALE',
      intent: 'SECRET INTENT',
      expected_effect: { signal: 'SECRET SIGNAL', direction: 'increase' },
      status: 'parked',
      at: '2026-11-15T00:00:00Z',
      dot_id: charter.dot_id,
      actor_id: 'dot:' + charter.dot_id,
      proposal_hash: 'fixture',
    } as DotActionRecord;
    const input = dotWorkItemInput(charter, row);
    expect(input.title).toBe(canonical.title);
    expect(input.description).toBe(canonical.objective);
    expect(input.metadata?.front_desk_execution).toEqual(binding);
    expect(input.metadata?.dot_private_body).toBeUndefined();
    expect(JSON.stringify(input)).not.toContain('SECRET');
    expect(() =>
      dotWorkItemInput(
        { ...charter, scope: { tier: 'confidential', tenant_slug: 'synthetic' } },
        row
      )
    ).toThrow('FRONT_DESK_REFERENCE_SCOPE');
    expect(() =>
      dotWorkItemInput({ ...charter, scope: { tier: 'personal', owner_nhi: 'user:owner' } }, row)
    ).toThrow('FRONT_DESK_REFERENCE_SCOPE');
    expect(() =>
      dotWorkItemInput(charter, {
        ...row,
        front_desk_execution: { ...binding, request_id: 'SECRET' },
      })
    ).toThrow('FRONT_DESK_REFERENCE_SCOPE');
  });
  it.each([false, true])(
    'keeps shared creation/events categorical and restores authorized objective (handoff=%s)',
    async (handoff) => {
      const f = fixture(handoff);
      const bytes =
        String(
          safeReadFile(
            pathResolver.rootResolve(f.rootDir + '/' + WORK_COORDINATION_ROOT_PATH + '/items.jsonl')
          )
        ) +
        String(
          safeReadFile(
            pathResolver.rootResolve(
              f.rootDir + '/active/shared/observability/work-coordination/events.jsonl'
            )
          )
        );
      for (const text of [
        'SECRET TITLE',
        'SECRET OBJECTIVE',
        'SECRET RATIONALE',
        'SECRET INTENT',
        'SECRET SIGNAL',
        'Private source title',
      ])
        expect(bytes).not.toContain(text);
      const result = await executeDotWorkItem(f.executor, f.item, f.ports, f.deps);
      expect(result.status).toBe('done');
      expect(f.runGoalTurn.mock.calls[0]?.[0]).toMatchObject({
        objective: expect.stringContaining('SECRET OBJECTIVE'),
      });
      expect(f.claim).toHaveBeenCalledOnce();
    }
  );
  it.each(['pipeline_ref', 'requested_execution_shape', 'target', 'action_id'] as const)(
    'holds changed %s before claim/provider',
    async (field) => {
      const f = fixture();
      f.item.metadata![field] = field === 'requested_execution_shape' ? 'pipeline' : 'changed';
      const result = await executeDotWorkItem(f.executor, f.item, f.ports, f.deps);
      expect(result.status).toBe('skipped');
      expect(f.claim).not.toHaveBeenCalled();
      expect(f.runGoalTurn).not.toHaveBeenCalled();
    }
  );
  it('uses frozen admitted objective even if a later status row changes top-level prose', () => {
    const f = fixture();
    appendActionRecord(
      { ...f.record, title: 'MUTATED TITLE', objective: 'MUTATED OBJECTIVE' },
      { rootDir: f.rootDir }
    );
    expect(restoreDotWorkItemBody(f.executor, f.item, f.rootDir)).toMatchObject({
      title: 'SECRET TITLE',
      description: expect.stringContaining('SECRET OBJECTIVE'),
    });
  });
  it('holds missing protected source and another owner before claim/provider', async () => {
    const f = fixture();
    const foreign = await executeDotWorkItem(
      { ...f.executor, scope: { ...f.executor.scope, owner_nhi: 'user:foreign' } },
      f.item,
      f.ports,
      f.deps
    );
    expect(foreign.status).toBe('skipped');
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.runGoalTurn).not.toHaveBeenCalled();
    safeRmSync(
      pathResolver.rootResolve(f.rootDir + '/' + dotStatePath(f.source, 'action-ledger.jsonl'))
    );
    const missing = await executeDotWorkItem(f.executor, f.item, f.ports, f.deps);
    expect(missing.status).toBe('skipped');
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.runGoalTurn).not.toHaveBeenCalled();
  });
});
