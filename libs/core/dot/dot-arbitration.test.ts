import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendJsonLine } from '../foundation/json.js';
import { safeMkdir, safeRmSync } from '../secure-io.js';
import type {
  AutonomousOpsGateInput,
  AutonomousOpsGateResult,
} from '../governance/autonomous-ops-gate.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import type {
  RouteAutonomousDecisionInput,
  RoutedDecision,
} from '../governance/approval-decision-routing.js';
import type { UpdateWorkItemInput, WorkItem } from '../workforce/work-coordination-types.js';
import type { DotCharter } from './dot-charter.js';
import {
  checkDotArbitration,
  dotArbitrationPreGateCheck,
  dotTargetsOverlap,
  readDotArbitrationRows,
  settleDotArbitration,
  type DotArbitrationDeps,
} from './dot-arbitration.js';
import {
  DOT_ACTION_LEDGER_PATH,
  currentDotActions,
  dispatchDotProposals,
  dotProposalHash,
  type DotActionRecord,
  type DotDispatchDeps,
} from './dot-dispatch.js';
import { DOT_PRE_GATE_CHECKS } from './dot-extension-registry.js';
import { listClaimableDotWorkItems } from './dot-executor.js';
import type { DotInboxEntryInput } from './dot-inbox.js';
import { learnedDotDecisionFloor, readDotFeedback } from './dot-feedback.js';
import type { DotProposal } from './dot-proposals.js';

const TEST_ROOT = `active/shared/tmp/dot-arbitration-tests-${randomUUID()}`;
const NOW = new Date('2026-10-04T09:00:00Z');
const ctx = { rootDir: TEST_ROOT, now: () => NOW };

function charter(dotId: string, team: DotCharter['team'] = {}, tenant?: string): DotCharter {
  return {
    kind: 'dot-charter',
    dot_id: dotId,
    version: '1.0.0',
    title: `Dot ${dotId}`,
    purpose: 'Arbitration test.',
    status: 'active',
    scope: tenant ? { tier: 'confidential', tenant_slug: tenant } : { tier: 'public' },
    goal: { statement: 'Stay out of each other’s way.' },
    attention: { triggers: [{ kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' }] },
    authority: { authority_role: 'infrastructure_sentinel' },
    notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
    runtime: { heartbeat_id: `dot-${dotId}` },
    team,
  };
}

const PROPOSAL: DotProposal = {
  action_id: 'dot_delegate_work',
  title: 'Remove the legacy config',
  objective: 'Delete src/legacy/config.ts.',
  work_shape: 'task_session',
  target: 'path:src/legacy/**',
  intent: 'remove',
};

function seedOlder(overrides: Partial<DotActionRecord> = {}): DotActionRecord {
  const row: DotActionRecord = {
    action_ref: 'dact-older-1',
    dot_id: 'older',
    actor_id: 'dot:older',
    action_id: 'dot_delegate_work',
    title: 'Create the legacy config',
    objective: 'Add src/legacy/config.ts.',
    work_shape: 'task_session',
    status: 'parked',
    proposal_hash: 'h-older',
    request_id: 'req-older',
    target: 'path:src/legacy/config.ts',
    intent: 'create',
    at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
  const file = path.join(TEST_ROOT, DOT_ACTION_LEDGER_PATH);
  safeMkdir(path.dirname(file), { recursive: true });
  appendJsonLine(file, row);
  return row;
}

function deps(charters: DotCharter[], extra: Partial<DotArbitrationDeps> = {}): DotArbitrationDeps {
  return { rootDir: TEST_ROOT, listCharters: () => charters, ...extra };
}

let savedChecks: typeof DOT_PRE_GATE_CHECKS = [];
beforeEach(() => {
  savedChecks = [...DOT_PRE_GATE_CHECKS];
});
afterEach(() => {
  DOT_PRE_GATE_CHECKS.length = 0;
  DOT_PRE_GATE_CHECKS.push(...savedChecks);
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('dot arbitration — target matching', () => {
  it('overlaps equal targets and path globs, never across kinds', () => {
    expect(dotTargetsOverlap('path:src/**', 'path:src/a/b.ts')).toBe(true);
    expect(dotTargetsOverlap('path:src/*.ts', 'path:src/a/b.ts')).toBe(false);
    expect(dotTargetsOverlap('path:src/a/**', 'path:src/*/x.ts')).toBe(true);
    expect(dotTargetsOverlap('path:docs/**', 'path:src/**')).toBe(false);
    expect(dotTargetsOverlap('service:api', 'service:api')).toBe(true);
    expect(dotTargetsOverlap('service:api', 'path:api')).toBe(false);
  });
});

describe('dot arbitration — pre-gate check', () => {
  it('registers the check in the registry', () => {
    expect(savedChecks.map((check) => check.id)).toContain('dot-arbitration');
  });

  it('never conflicts for a proposal without a target', () => {
    seedOlder();
    const { target: _t, intent: _i, ...untargeted } = PROPOSAL;
    expect(
      checkDotArbitration(charter('newcomer'), untargeted, ctx, deps([charter('older')]))
    ).toEqual({ ok: true });
  });

  it('refuses the newcomer when the other dot is the sole owner', () => {
    seedOlder();
    const owner = charter('older', { owns: ['path:src/legacy/**'] });
    const verdict = checkDotArbitration(charter('newcomer'), PROPOSAL, ctx, deps([owner]));
    expect(verdict).toMatchObject({ ok: false });
    expect(verdict.ok === false && verdict.reason).toContain('owned by dot:older');
    expect(readDotArbitrationRows(charter('newcomer'), { rootDir: TEST_ROOT })[0]).toMatchObject({
      resolution: 'defer_to_owner',
      conflicts_with: { dot_id: 'older', action_ref: 'dact-older-1' },
    });
  });

  it('owner priority beats raw priority', () => {
    seedOlder();
    const newcomer = charter('newcomer', { owns: ['path:src/**'], priority: 10 });
    const verdict = checkDotArbitration(
      newcomer,
      PROPOSAL,
      ctx,
      deps([charter('older', { priority: 90 })])
    );
    expect(verdict.ok).toBe('escalate');
  });

  it('a priority gap of 10 decides: higher older refuses, higher newcomer escalates to supersede', () => {
    seedOlder();
    const refused = checkDotArbitration(
      charter('newcomer', { priority: 50 }),
      PROPOSAL,
      ctx,
      deps([charter('older', { priority: 60 })])
    );
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain('higher priority');

    const wins = checkDotArbitration(
      charter('newcomer', { priority: 70 }),
      PROPOSAL,
      ctx,
      deps([charter('older', { priority: 60 })])
    );
    expect(wins).toMatchObject({
      ok: 'escalate',
      link: { action_ref: 'dact-older-1', dot_id: 'older' },
    });
    expect(wins.ok === 'escalate' && wins.card_context).toContain('wins by priority');
  });

  it('never compares dots in different tenant scopes', () => {
    seedOlder();
    const verdict = checkDotArbitration(
      charter('newcomer', {}, 'acme'),
      PROPOSAL,
      ctx,
      deps([charter('older', { owns: ['path:**'] }, 'globex')])
    );
    expect(verdict).toEqual({ ok: true });
    // Same tenant on both sides does conflict.
    const same = checkDotArbitration(
      charter('newcomer', {}, 'acme'),
      PROPOSAL,
      ctx,
      deps([charter('older', {}, 'acme')])
    );
    expect(same.ok).toBe('escalate');
  });

  it('ignores stale actions and dispatched actions whose WorkItem is closed', () => {
    seedOlder({ at: new Date(NOW.getTime() - 7 * 60 * 60 * 1000).toISOString() });
    expect(
      checkDotArbitration(charter('newcomer'), PROPOSAL, ctx, deps([charter('older')]))
    ).toEqual({
      ok: true,
    });
    seedOlder({ action_ref: 'dact-older-2', status: 'dispatched', work_item_id: 'w-1' });
    const closed = deps([charter('older')], {
      getWorkItem: () => ({ item_id: 'w-1', status: 'done' }) as WorkItem,
    });
    expect(checkDotArbitration(charter('newcomer'), PROPOSAL, ctx, closed)).toEqual({ ok: true });
    const open = deps([charter('older')], {
      getWorkItem: () => ({ item_id: 'w-1', status: 'in_progress' }) as WorkItem,
    });
    expect(checkDotArbitration(charter('newcomer'), PROPOSAL, ctx, open).ok).toBe('escalate');
  });
});

const RANK = { auto: 0, notify: 1, approve: 2 } as const;

function dispatchHarness() {
  const routed: RouteAutonomousDecisionInput[] = [];
  const d: DotDispatchDeps = {
    rootDir: TEST_ROOT,
    now: () => NOW,
    gate: (input: AutonomousOpsGateInput) =>
      ({
        actionId: input.actionId,
        decision:
          input.requestedDecision && RANK[input.requestedDecision] > 0
            ? input.requestedDecision
            : 'auto',
        allowed: true,
        reason: 'test gate',
        shadow: false,
      }) as AutonomousOpsGateResult,
    route: (input): RoutedDecision => {
      routed.push(input);
      return input.gate.decision === 'approve'
        ? {
            level: 'approve',
            timing: 'immediate',
            proceed: false,
            parked: true,
            shadow: false,
            requestId: `req-${routed.length}`,
            notified: true,
          }
        : {
            level: 'none',
            timing: 'digest',
            proceed: true,
            parked: false,
            shadow: false,
            notified: false,
          };
    },
    createWorkItem: () => ({ item_id: 'w-new' }) as WorkItem,
    countOpenWorkItems: () => 0,
    assertTenant: () => {},
    appendInbox: () => {},
    notify: () => true,
    audit: () => {},
    feedback: { onRejection: () => {} },
  };
  return { d, routed };
}

describe('dot arbitration — escalation and settlement', () => {
  it('escalates as ONE approve card listing both proposals and the superseded action', () => {
    seedOlder();
    DOT_PRE_GATE_CHECKS.length = 0;
    DOT_PRE_GATE_CHECKS.push(dotArbitrationPreGateCheck(deps([charter('older')])));
    const newcomer = charter('newcomer');
    const h = dispatchHarness();
    const { records } = dispatchDotProposals(newcomer, [PROPOSAL], {
      ...h.d,
      listCharters: () => [newcomer, charter('older')],
    });
    expect(h.routed).toHaveLength(1);
    expect(h.routed[0].gate.decision).toBe('approve');
    const question = h.routed[0].question;
    expect(question).toContain('Remove the legacy config');
    expect(question).toContain('Create the legacy config');
    expect(question).toContain('supersedes dact-older-1');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: 'parked',
      escalation: {
        check_id: 'dot-arbitration',
        link: { action_ref: 'dact-older-1', dot_id: 'older' },
      },
    });
    expect(readDotArbitrationRows(newcomer, { rootDir: TEST_ROOT })).toHaveLength(1);
  });

  function seedNewcomer(status: DotActionRecord['status'], reason?: string): void {
    const file = path.join(TEST_ROOT, DOT_ACTION_LEDGER_PATH);
    appendJsonLine(file, {
      action_ref: 'dact-new-1',
      dot_id: 'newcomer',
      actor_id: 'dot:newcomer',
      action_id: 'dot_delegate_work',
      title: PROPOSAL.title,
      objective: PROPOSAL.objective,
      work_shape: 'task_session',
      status,
      proposal_hash: 'h-new',
      request_id: 'req-new',
      target: PROPOSAL.target,
      intent: PROPOSAL.intent,
      escalation: {
        check_id: 'dot-arbitration',
        reason: 'conflict',
        link: { action_ref: 'dact-older-1', dot_id: 'older' },
      },
      ...(reason ? { reason } : {}),
      at: NOW.toISOString(),
    } satisfies DotActionRecord);
  }

  it('approved: declines the older parked action as superseded without raising its floor', () => {
    seedOlder();
    seedNewcomer('dispatched');
    const expired: string[] = [];
    const older = charter('older');
    const result = settleDotArbitration(
      charter('newcomer'),
      NOW,
      deps([older], {
        dispatch: {
          loadApproval: (id) => ({ id, status: 'pending' }) as ApprovalRequestRecord,
          expireApproval: (record) => {
            expired.push(record.id);
            return { ...record, status: 'expired' } as ApprovalRequestRecord;
          },
          audit: () => {},
        },
      })
    );
    expect(result).toEqual([
      expect.objectContaining({ resolution: 'superseded', effect: 'declined_parked' }),
    ]);
    const olderRow = currentDotActions('older', { rootDir: TEST_ROOT })[0];
    expect(olderRow).toMatchObject({
      status: 'declined',
      reason: 'superseded',
      superseded_by: { dot_id: 'newcomer', action_ref: 'dact-new-1' },
    });
    expect(expired).toEqual(['req-older']);
    const fb = { rootDir: TEST_ROOT, now: () => NOW };
    expect(readDotFeedback('older', fb)).toEqual([]);
    expect(learnedDotDecisionFloor('older', fb)).toBeUndefined();
    // Idempotent.
    expect(settleDotArbitration(charter('newcomer'), NOW, deps([older]))).toEqual([]);
  });

  it('approved: blocks the open WorkItem of a dispatched older action', () => {
    seedOlder({ status: 'dispatched', work_item_id: 'w-older' });
    seedNewcomer('dispatched');
    const updates: UpdateWorkItemInput[] = [];
    const result = settleDotArbitration(
      charter('newcomer'),
      NOW,
      deps([charter('older')], {
        getWorkItem: (id) =>
          ({
            item_id: id,
            status: 'ready',
            version: 3,
            metadata: { dot_id: 'older' },
          }) as unknown as WorkItem,
        updateWorkItem: (input) => {
          updates.push(input);
          return { item_id: input.itemId } as WorkItem;
        },
      })
    );
    expect(result[0]).toMatchObject({ effect: 'blocked_work_item' });
    expect(updates[0]).toMatchObject({
      itemId: 'w-older',
      expectedVersion: 3,
      status: 'blocked',
      metadata: {
        dot_id: 'older',
        superseded_by: { dot_id: 'newcomer', action_ref: 'dact-new-1' },
      },
    });
  });

  it('approved in the same sweep the older WorkItem is ready: it is blocked and never claimable', () => {
    seedOlder({ status: 'dispatched', work_item_id: 'w-older' });
    seedNewcomer('dispatched');
    const store = new Map<string, WorkItem>([
      [
        'w-older',
        {
          item_id: 'w-older',
          status: 'ready',
          version: 1,
          created_at: NOW.toISOString(),
          metadata: { dot_id: 'older' },
        } as unknown as WorkItem,
      ],
    ]);
    const older = charter('older');
    expect(listClaimableDotWorkItems(older, { listItems: () => [...store.values()] })).toHaveLength(
      1
    );
    settleDotArbitration(
      charter('newcomer'),
      NOW,
      deps([older], {
        getWorkItem: (id) => store.get(id) ?? null,
        updateWorkItem: (input) => {
          const current = store.get(input.itemId)!;
          if (input.expectedVersion !== current.version) throw new Error('version conflict');
          const next = {
            ...current,
            status: input.status ?? current.status,
            metadata: input.metadata ?? current.metadata,
            version: current.version + 1,
          } as WorkItem;
          store.set(input.itemId, next);
          return next;
        },
      })
    );
    // The settle step runs before the executor: nothing is left to claim.
    expect(store.get('w-older')?.status).toBe('blocked');
    expect(listClaimableDotWorkItems(older, { listItems: () => [...store.values()] })).toEqual([]);
  });

  it('approved: never overwrites a claimed in-progress WorkItem — flags it and notes both inboxes', () => {
    seedOlder({ status: 'dispatched', work_item_id: 'w-older' });
    seedNewcomer('dispatched');
    const updates: UpdateWorkItemInput[] = [];
    const notes: DotInboxEntryInput[] = [];
    const result = settleDotArbitration(
      charter('newcomer'),
      NOW,
      deps([charter('older')], {
        getWorkItem: (id) =>
          ({
            item_id: id,
            status: 'in_progress',
            version: 4,
            lease_id: 'lease-1',
            metadata: { dot_id: 'older' },
          }) as unknown as WorkItem,
        updateWorkItem: (input) => {
          updates.push(input);
          return { item_id: input.itemId } as WorkItem;
        },
        appendInbox: (input) => notes.push(input),
      })
    );
    expect(result[0]).toMatchObject({ resolution: 'superseded', effect: 'flagged_claimed' });
    expect(updates).toEqual([]);
    expect(notes.map((note) => note.dot_id).sort()).toEqual(['newcomer', 'older']);
    expect(notes[0]).toMatchObject({
      channel: 'inbox',
      source: 'dot-arbitration',
      payload: { work_item_id: 'w-older' },
    });
    expect(
      readDotArbitrationRows(charter('newcomer'), { rootDir: TEST_ROOT }).at(-1)
    ).toMatchObject({
      resolution: 'superseded',
      reason: expect.stringContaining('already claimed'),
    });
    // Recorded once: the next sweep does not re-flag it.
    expect(settleDotArbitration(charter('newcomer'), NOW, deps([charter('older')]))).toEqual([]);
  });

  it('a version conflict leaves the settlement for the next sweep', () => {
    seedOlder({ status: 'dispatched', work_item_id: 'w-older' });
    seedNewcomer('dispatched');
    const result = settleDotArbitration(
      charter('newcomer'),
      NOW,
      deps([charter('older')], {
        getWorkItem: (id) =>
          ({ item_id: id, status: 'ready', version: 1, metadata: {} }) as unknown as WorkItem,
        updateWorkItem: () => {
          throw new Error('[VERSION_CONFLICT] expected 1, found 2');
        },
      })
    );
    expect(result).toEqual([]);
    expect(readDotArbitrationRows(charter('newcomer'), { rootDir: TEST_ROOT })).toEqual([]);
  });

  it('rejected: the newcomer stays declined and the older action continues', () => {
    seedOlder();
    seedNewcomer('declined', 'approval rejected');
    const result = settleDotArbitration(charter('newcomer'), NOW, deps([charter('older')]));
    expect(result).toEqual([expect.objectContaining({ resolution: 'declined', effect: 'none' })]);
    expect(currentDotActions('older', { rootDir: TEST_ROOT })[0].status).toBe('parked');
  });
});

describe('dotProposalHash', () => {
  it('distinguishes proposals that differ only by target, intent or pipeline_ref', () => {
    const base = { ...PROPOSAL, target: undefined, intent: undefined };
    const create = dotProposalHash('d', { ...PROPOSAL, intent: 'create' });
    const remove = dotProposalHash('d', { ...PROPOSAL, intent: 'remove' });
    expect(create).not.toBe(remove);
    expect(dotProposalHash('d', { ...PROPOSAL, target: 'path:docs/**' })).not.toBe(remove);
    expect(dotProposalHash('d', { ...base, pipeline_ref: 'pipelines/a.json' })).not.toBe(
      dotProposalHash('d', { ...base, pipeline_ref: 'pipelines/b.json' })
    );
    // Proposals without those fields keep their previous hash.
    const legacy = createHash('sha256')
      .update(JSON.stringify(['d', base.action_id, base.title, base.objective, '']))
      .digest('hex')
      .slice(0, 16);
    expect(dotProposalHash('d', base)).toBe(legacy);
  });
});

describe('dot handoff tenant isolation', () => {
  function handoff(from: DotCharter, to: DotCharter) {
    const h = dispatchHarness();
    const audits: Array<{ result?: string; metadata?: Record<string, unknown> }> = [];
    const { records } = dispatchDotProposals(
      from,
      [{ ...PROPOSAL, target: undefined, action_id: 'dot_handoff', handoff_to: to.dot_id }],
      { ...h.d, listCharters: () => [from, to], audit: (entry) => void audits.push(entry) }
    );
    return { record: records[0], audits };
  }
  const accepting = (dotId: string, tenant?: string, org?: string): DotCharter => {
    const c = charter(dotId, { accepts_handoffs_from: ['sender'] }, tenant);
    return org ? { ...c, scope: { ...c.scope, organization_id: org } } : c;
  };

  it('refuses (and audits) a handoff to a dot in another tenant or organization', () => {
    const crossTenant = handoff(charter('sender', {}, 'acme'), accepting('receiver', 'globex'));
    expect(crossTenant.record).toMatchObject({ status: 'refused' });
    expect(crossTenant.record.reason).toContain('cross-tenant handoff denied');
    expect(crossTenant.audits[0]).toMatchObject({
      result: 'denied',
      metadata: { reason: expect.stringContaining('cross-tenant handoff denied') },
    });
    const untenantedToTenant = handoff(charter('sender'), accepting('receiver', 'acme'));
    expect(untenantedToTenant.record.reason).toContain('cross-tenant handoff denied');
    const sender = { ...charter('sender', {}, 'acme') };
    sender.scope = { ...sender.scope, organization_id: 'org-a' };
    const crossOrg = handoff(sender, accepting('receiver', 'acme', 'org-b'));
    expect(crossOrg.record.reason).toContain('cross-tenant handoff denied');
  });

  it('allows a handoff inside the same tenant scope', () => {
    const same = handoff(charter('sender', {}, 'acme'), accepting('receiver', 'acme', 'org-a'));
    expect(same.record).toMatchObject({ status: 'dispatched', handoff_to: 'receiver' });
  });
});
