import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import {
  recordActionItem,
  updateActionItemStatus,
  appendReminder,
  listActionItems,
  listOperatorSelfPending,
  listOthersPending,
  nextActionItemId,
  summarizeActionItemLifecycle,
} from './action-item-store.js';
import * as pathResolver from './path-resolver.js';

const FIX_MISSION = 'MSN-AI-STORE-FIXTURE-001';
const ROOT = pathResolver.rootDir();
const MISSION_DIR = path.join(ROOT, 'active/missions/confidential', FIX_MISSION);

describe('action-item-store', () => {
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  let savedMission: string | undefined;

  beforeEach(() => {
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    savedMission = process.env.MISSION_ID;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.MISSION_ID = FIX_MISSION;
    fs.mkdirSync(path.join(MISSION_DIR, 'evidence'), { recursive: true });
    fs.writeFileSync(
      path.join(MISSION_DIR, 'mission-state.json'),
      JSON.stringify({
        mission_id: FIX_MISSION,
        tier: 'confidential',
        assigned_persona: 'ecosystem_architect',
      }),
    );
  });

  afterEach(() => {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (savedMission === undefined) delete process.env.MISSION_ID;
    else process.env.MISSION_ID = savedMission;
    try {
      fs.rmSync(MISSION_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('records and reads back an action item', () => {
    const recorded = recordActionItem({
      item_id: 'AI-FOO-1',
      mission_id: FIX_MISSION,
      title: 'Send the revised proposal to compliance',
      assignee: { kind: 'operator_self', label: 'Operator' },
    });
    expect(recorded.status).toBe('pending');
    expect(recorded.created_at).toMatch(/^\d{4}-/);

    const all = listActionItems(FIX_MISSION);
    expect(all).toHaveLength(1);
    expect(all[0].item_id).toBe('AI-FOO-1');
    expect(all[0].title).toBe('Send the revised proposal to compliance');
  });

  it('rejects bad item_id pattern', () => {
    expect(() =>
      recordActionItem({
        item_id: 'bad-id',
        mission_id: FIX_MISSION,
        title: 'something happens',
        assignee: { kind: 'operator_self', label: 'Operator' },
      }),
    ).toThrow(/invalid item_id/);
  });

  it('rejects duplicate item_id within the same mission', () => {
    recordActionItem({
      item_id: 'AI-DUP-1',
      mission_id: FIX_MISSION,
      title: 'first item is recorded fine',
      assignee: { kind: 'operator_self', label: 'Operator' },
    });
    expect(() =>
      recordActionItem({
        item_id: 'AI-DUP-1',
        mission_id: FIX_MISSION,
        title: 'duplicate of the same id',
        assignee: { kind: 'operator_self', label: 'Operator' },
      }),
    ).toThrow(/already exists/);
  });

  it('updates status and reflects the latest record on read', () => {
    recordActionItem({
      item_id: 'AI-PROG-1',
      mission_id: FIX_MISSION,
      title: 'a progress demo item to drive',
      assignee: { kind: 'operator_self', label: 'Operator' },
    });
    const updated = updateActionItemStatus({
      mission_id: FIX_MISSION,
      item_id: 'AI-PROG-1',
      status: 'in_progress',
    });
    expect(updated?.status).toBe('in_progress');

    const completed = updateActionItemStatus({
      mission_id: FIX_MISSION,
      item_id: 'AI-PROG-1',
      status: 'completed',
      execution: { executed_via: 'pipeline', execution_ref: 'pipelines/foo.json' },
    });
    expect(completed?.status).toBe('completed');
    expect(completed?.completed_at).toBeDefined();
    expect(completed?.execution?.executed_via).toBe('pipeline');

    const view = listActionItems(FIX_MISSION);
    expect(view[0].status).toBe('completed');
  });

  it('persists blocked_reason on blocked transitions and summarizes owner kinds', () => {
    recordActionItem({
      item_id: 'AI-BLOCK-1',
      mission_id: FIX_MISSION,
      title: 'blocked item needs a manual hold',
      assignee: { kind: 'team_member', label: 'Alice' },
    });
    const blocked = updateActionItemStatus({
      mission_id: FIX_MISSION,
      item_id: 'AI-BLOCK-1',
      status: 'blocked',
      blocked_reason: 'manual approval still pending',
      execution: { executed_via: 'manual', result_summary: 'manual approval still pending' },
    });
    expect(blocked?.blocked_reason).toBe('manual approval still pending');
    expect(listActionItems(FIX_MISSION)[0].blocked_reason).toBe('manual approval still pending');

    const summary = summarizeActionItemLifecycle(FIX_MISSION);
    expect(summary.by_owner_kind.team_member).toBeGreaterThan(0);
    expect(summary.blocked_items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item_id: 'AI-BLOCK-1',
          owner_kind: 'team_member',
          blocked_reason: 'manual approval still pending',
        }),
      ]),
    );
  });

  it('returns null on update of unknown item', () => {
    const r = updateActionItemStatus({
      mission_id: FIX_MISSION,
      item_id: 'AI-NOPE-9',
      status: 'completed',
    });
    expect(r).toBeNull();
  });

  it('appends reminders idempotently on (sent_at, channel)', () => {
    recordActionItem({
      item_id: 'AI-REM-1',
      mission_id: FIX_MISSION,
      title: 'an item that other people own and we remind',
      assignee: { kind: 'team_member', label: 'Alice' },
    });
    const sent_at = '2026-04-27T10:00:00.000Z';
    appendReminder({
      mission_id: FIX_MISSION,
      item_id: 'AI-REM-1',
      reminder: { sent_at, channel: 'slack:@alice', message: 'gentle reminder' },
    });
    appendReminder({
      mission_id: FIX_MISSION,
      item_id: 'AI-REM-1',
      reminder: { sent_at, channel: 'slack:@alice', message: 'gentle reminder again' },
    });
    const item = listActionItems(FIX_MISSION).find((i) => i.item_id === 'AI-REM-1');
    expect(item?.reminders ?? []).toHaveLength(1);
  });

  it('listOperatorSelfPending and listOthersPending filter correctly', () => {
    recordActionItem({
      item_id: 'AI-S-1',
      mission_id: FIX_MISSION,
      title: 'self item one is created here',
      assignee: { kind: 'operator_self', label: 'Operator' },
    });
    recordActionItem({
      item_id: 'AI-S-2',
      mission_id: FIX_MISSION,
      title: 'self item two and we mark it done',
      assignee: { kind: 'operator_self', label: 'Operator' },
    });
    updateActionItemStatus({
      mission_id: FIX_MISSION,
      item_id: 'AI-S-2',
      status: 'completed',
    });
    recordActionItem({
      item_id: 'AI-T-1',
      mission_id: FIX_MISSION,
      title: 'other person item one to track',
      assignee: { kind: 'team_member', label: 'Alice' },
    });

    const selfPending = listOperatorSelfPending(FIX_MISSION);
    expect(selfPending.map((i) => i.item_id)).toEqual(['AI-S-1']);
    const othersPending = listOthersPending(FIX_MISSION);
    expect(othersPending.map((i) => i.item_id)).toEqual(['AI-T-1']);
  });

  it('generates a deterministic next id from existing count', () => {
    const first = nextActionItemId(FIX_MISSION, 'budget');
    expect(first).toMatch(/^AI-/);
    expect(first).toContain('BUDGET');
  });

  it('non-declarative items land in pending_speaker_review and are NOT eligible', async () => {
    const { listPendingSpeakerReview, confirmActionItemBySpeaker } = await import(
      './action-item-store.js'
    );
    recordActionItem({
      item_id: 'AI-MOD-1',
      mission_id: FIX_MISSION,
      title: 'maybe try a different approach next time',
      assignee: { kind: 'operator_self', label: 'Operator' },
      modality: 'hypothetical',
      review_state: 'pending_speaker_review',
    });
    recordActionItem({
      item_id: 'AI-MOD-2',
      mission_id: FIX_MISSION,
      title: 'send the revised proposal to compliance',
      assignee: { kind: 'operator_self', label: 'Operator' },
      modality: 'declarative',
    });
    const selfPending = listOperatorSelfPending(FIX_MISSION);
    expect(selfPending.map((i) => i.item_id)).toEqual(['AI-MOD-2']);
    const review = listPendingSpeakerReview(FIX_MISSION);
    expect(review.map((i) => i.item_id)).toEqual(['AI-MOD-1']);

    // After speaker confirmation, the hypothetical item becomes eligible.
    const confirmed = confirmActionItemBySpeaker({
      mission_id: FIX_MISSION,
      item_id: 'AI-MOD-1',
      decision: 'speaker_confirmed',
      note: 'speaker says yes, please track this',
    });
    expect(confirmed?.review_state).toBe('speaker_confirmed');
    const selfPending2 = listOperatorSelfPending(FIX_MISSION);
    expect(selfPending2.map((i) => i.item_id).sort()).toEqual(['AI-MOD-1', 'AI-MOD-2']);
  });

  it('listOthersPending stops at max_reminders', async () => {
    const { listOthersPending } = await import('./action-item-store.js');
    recordActionItem({
      item_id: 'AI-CAP-1',
      mission_id: FIX_MISSION,
      title: 'team item that we already reminded a lot',
      assignee: { kind: 'team_member', label: 'Alice' },
      max_reminders: 3,
    });
    for (let n = 0; n < 3; n++) {
      appendReminder({
        mission_id: FIX_MISSION,
        item_id: 'AI-CAP-1',
        reminder: {
          sent_at: `2026-04-${20 + n}T10:00:00.000Z`,
          channel: 'slack:@alice',
        },
      });
    }
    expect(listOthersPending(FIX_MISSION).map((i: any) => i.item_id)).not.toContain('AI-CAP-1');

    recordActionItem({
      item_id: 'AI-CAP-2',
      mission_id: FIX_MISSION,
      title: 'team item that has not been reminded yet',
      assignee: { kind: 'team_member', label: 'Bob' },
    });
    expect(listOthersPending(FIX_MISSION).map((i: any) => i.item_id)).toContain('AI-CAP-2');
  });

  it('partial_state items are NOT eligible until cleared', async () => {
    const { listPartialStatePending, clearPartialState } = await import(
      './action-item-store.js'
    );
    recordActionItem({
      item_id: 'AI-PART-1',
      mission_id: FIX_MISSION,
      title: 'partial state must fail closed by default',
      assignee: { kind: 'operator_self', label: 'Operator' },
      policy: { partial_state: true },
    });
    expect(listOperatorSelfPending(FIX_MISSION).map((i) => i.item_id)).not.toContain('AI-PART-1');
    expect(listPartialStatePending(FIX_MISSION).map((i) => i.item_id)).toEqual(['AI-PART-1']);

    const cleared = clearPartialState({
      mission_id: FIX_MISSION,
      item_id: 'AI-PART-1',
      note: 'operator reviewed transcript and confirmed item is real',
    });
    expect(cleared?.policy?.partial_state).toBe(false);
    expect(listOperatorSelfPending(FIX_MISSION).map((i) => i.item_id)).toContain('AI-PART-1');
  });

  it('restricted items round-trip through listRestrictedPending', async () => {
    const { listRestrictedPending } = await import('./action-item-store.js');
    recordActionItem({
      item_id: 'AI-REST-1',
      mission_id: FIX_MISSION,
      title: 'wire transfer to vendor of last quarter receivable',
      assignee: { kind: 'operator_self', label: 'Operator' },
      policy: { restricted: true, restriction_rule_id: 'rest.financial-transfer' },
    });
    const restricted = listRestrictedPending(FIX_MISSION);
    expect(restricted.map((i) => i.item_id)).toEqual(['AI-REST-1']);
    expect(restricted[0].policy?.restriction_rule_id).toBe('rest.financial-transfer');
  });

  it('legacy flat-form policy fields are migrated on read', () => {
    const file = path.join(MISSION_DIR, 'evidence/action-items.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const legacy = {
      item_id: 'AI-LEGACY-1',
      mission_id: FIX_MISSION,
      title: 'legacy flat-form record from before the refactor',
      assignee: { kind: 'operator_self', label: 'Operator' },
      status: 'pending',
      created_at: '2026-04-26T10:00:00.000Z',
      partial_state: true,
      restricted: true,
      restriction_rule_id: 'rest.financial-transfer',
      manager_handle: 'slack:@mgr',
    };
    fs.writeFileSync(file, JSON.stringify(legacy) + '\n');
    const items = listActionItems(FIX_MISSION);
    expect(items).toHaveLength(1);
    expect(items[0].policy).toEqual({
      partial_state: true,
      restricted: true,
      restriction_rule_id: 'rest.financial-transfer',
      manager_handle: 'slack:@mgr',
    });
    // Legacy flat fields should NOT be present on the migrated shape.
    expect((items[0] as any).partial_state).toBeUndefined();
    expect((items[0] as any).restricted).toBeUndefined();
  });

  it('speaker_rejected transitions the item to cancelled', async () => {
    const { confirmActionItemBySpeaker } = await import('./action-item-store.js');
    recordActionItem({
      item_id: 'AI-REJ-1',
      mission_id: FIX_MISSION,
      title: 'just a joke about deleting prod',
      assignee: { kind: 'operator_self', label: 'Operator' },
      modality: 'humor',
      review_state: 'pending_speaker_review',
    });
    const rejected = confirmActionItemBySpeaker({
      mission_id: FIX_MISSION,
      item_id: 'AI-REJ-1',
      decision: 'speaker_rejected',
      note: 'this was a joke, do not track',
    });
    expect(rejected?.review_state).toBe('speaker_rejected');
    expect(rejected?.status).toBe('cancelled');
    expect(listOperatorSelfPending(FIX_MISSION).map((i) => i.item_id)).not.toContain('AI-REJ-1');
  });
});
