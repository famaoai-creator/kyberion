import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pathResolver,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
  type ActionItem,
  type MeetingFacilitatorPolicy,
  listActionItems,
  recordActionItem,
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
  summarizeActionItemLifecycle,
} from '@agent/core';
import {
  applyRestrictedActionGate,
  auditSpeakerFairnessOp,
  executeSelfActionItemsOp,
  trackPendingActionItemsOp,
} from './decision-ops.js';

const FIX_MISSION = 'MSN-MTG-OPS-FIXTURE-001';
const ROOT = pathResolver.rootDir();
const MISSION_DIR = path.join(ROOT, 'active/missions/confidential', FIX_MISSION);

function basePolicy(overrides: Partial<MeetingFacilitatorPolicy> = {}): MeetingFacilitatorPolicy {
  return {
    restricted_approved_item_ids: new Set<string>(),
    sudo_override: false,
    reminder_cc_after_n: 3,
    speaker_fairness_total_threshold: 0.6,
    speaker_fairness_must_threshold: 0.7,
    restricted_actions_policy_path: 'knowledge/public/governance/restricted-action-kinds-policy.json',
    ...overrides,
  };
}

function makeItem(overrides: Partial<ActionItem>): ActionItem {
  return {
    item_id: 'AI-FOO-1',
    mission_id: FIX_MISSION,
    title: 'Send the revised proposal to compliance',
    assignee: { kind: 'operator_self', label: 'Operator' },
    status: 'pending',
    created_at: '2026-04-27T10:00:00.000Z',
    ...overrides,
  };
}

describe('applyRestrictedActionGate', () => {
  it('blocks restricted items by default', () => {
    const items = [
      makeItem({ item_id: 'AI-OK-1' }),
      makeItem({
        item_id: 'AI-REST-1',
        policy: { restricted: true, restriction_rule_id: 'rest.financial-transfer' },
      }),
    ];
    const { allowed, blocked } = applyRestrictedActionGate(items, {
      approved_item_ids: new Set(),
      sudo_override: false,
    });
    expect(allowed.map((i) => i.item_id)).toEqual(['AI-OK-1']);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].item.item_id).toBe('AI-REST-1');
    expect(blocked[0].rule_id).toBe('rest.financial-transfer');
    expect(blocked[0].reason).toContain('restricted-action-kinds gate');
  });

  it('lets approved item ids through', () => {
    const items = [
      makeItem({
        item_id: 'AI-REST-1',
        policy: { restricted: true, restriction_rule_id: 'rest.financial-transfer' },
      }),
    ];
    const { allowed, blocked } = applyRestrictedActionGate(items, {
      approved_item_ids: new Set(['AI-REST-1']),
      sudo_override: false,
    });
    expect(allowed.map((i) => i.item_id)).toEqual(['AI-REST-1']);
    expect(blocked).toHaveLength(0);
  });

  it('sudo override bypasses the gate entirely', () => {
    const items = [
      makeItem({
        item_id: 'AI-REST-1',
        policy: { restricted: true, restriction_rule_id: 'rest.financial-transfer' },
      }),
    ];
    const { allowed } = applyRestrictedActionGate(items, {
      approved_item_ids: new Set(),
      sudo_override: true,
    });
    expect(allowed).toHaveLength(1);
  });

  it('non-restricted items are unaffected by the approved set', () => {
    const items = [makeItem({ item_id: 'AI-OK-1' })];
    const { allowed, blocked } = applyRestrictedActionGate(items, {
      approved_item_ids: new Set(),
      sudo_override: false,
    });
    expect(allowed).toHaveLength(1);
    expect(blocked).toHaveLength(0);
  });
});

describe('action-item follow-up ops', () => {
  beforeEach(() => {
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.MISSION_ID = FIX_MISSION;
    safeMkdir(path.join(MISSION_DIR, 'evidence'), { recursive: true });
    safeWriteFile(
      path.join(MISSION_DIR, 'mission-state.json'),
      JSON.stringify({
        mission_id: FIX_MISSION,
        tier: 'confidential',
        assigned_persona: 'ecosystem_architect',
      }),
    );
    registerReasoningBackend({
      ...stubReasoningBackend,
      name: 'action-item-test',
      async delegateTask(prompt: string, taskId?: string) {
        if (taskId?.startsWith('self-exec:')) {
          return JSON.stringify({
            plan: `complete ${taskId}`,
            completion_summary: `completed ${taskId}`,
          });
        }
        return JSON.stringify({ text: `Reminder generated for ${taskId}: ${prompt.slice(0, 12)}` });
      },
    });
  });

  afterEach(() => {
    resetReasoningBackend();
    vi.useRealTimers();
    safeRmSync(MISSION_DIR, { recursive: true, force: true });
  });

  it('executeSelfActionItemsOp completes allowed pending self items and blocks restricted ones with reasons', async () => {
    recordActionItem({
      item_id: 'AI-SELF-1',
      mission_id: FIX_MISSION,
      title: 'prepare the operator follow up note',
      assignee: { kind: 'operator_self', label: 'Operator' },
    });
    recordActionItem({
      item_id: 'AI-REST-1',
      mission_id: FIX_MISSION,
      title: 'wire transfer to vendor after meeting',
      assignee: { kind: 'operator_self', label: 'Operator' },
      policy: { restricted: true, restriction_rule_id: 'rest.financial-transfer' },
    });

    const report = await executeSelfActionItemsOp({
      mission_id: FIX_MISSION,
      policy: basePolicy(),
    });
    const items = listActionItems(FIX_MISSION);
    const summary = summarizeActionItemLifecycle(FIX_MISSION);

    expect(report.dispatched.map((i) => i.item_id)).toEqual(['AI-SELF-1']);
    expect(report.skipped_restricted).toEqual([
      expect.objectContaining({
        item_id: 'AI-REST-1',
        restriction_rule_id: 'rest.financial-transfer',
      }),
    ]);
    expect(items.find((i) => i.item_id === 'AI-SELF-1')?.status).toBe('completed');
    expect(items.find((i) => i.item_id === 'AI-REST-1')?.status).toBe('blocked');
    expect(items.find((i) => i.item_id === 'AI-REST-1')?.blocked_reason).toContain(
      'restricted-action-kinds gate',
    );
    expect(summary.by_owner_kind.operator_self).toBe(2);
    expect(summary.blocked_items).toEqual([
      expect.objectContaining({
        item_id: 'AI-REST-1',
        owner_kind: 'operator_self',
        blocked_reason: expect.stringContaining('restricted-action-kinds gate'),
      }),
    ]);
  });

  it('trackPendingActionItemsOp reminds only pending team members and suppresses duplicate reminder records', async () => {
    vi.setSystemTime(new Date('2026-05-15T10:00:00.000Z'));
    recordActionItem({
      item_id: 'AI-TEAM-1',
      mission_id: FIX_MISSION,
      title: 'send customer agenda before Monday',
      assignee: { kind: 'team_member', label: 'Alice', channel_handle: 'slack:@alice' },
    });
    recordActionItem({
      item_id: 'AI-TEAM-BLOCK',
      mission_id: FIX_MISSION,
      title: 'blocked team follow up should not be reminded',
      assignee: { kind: 'team_member', label: 'Bob', channel_handle: 'slack:@bob' },
    });
    recordActionItem({
      item_id: 'AI-EXT-1',
      mission_id: FIX_MISSION,
      title: 'external owner should not receive internal reminder',
      assignee: { kind: 'external', label: 'Partner', channel_handle: 'email:partner@example.com' },
    });
    recordActionItem({
      item_id: 'AI-SELF-2',
      mission_id: FIX_MISSION,
      title: 'self item should not be in tracking reminder pass',
      assignee: { kind: 'operator_self', label: 'Operator' },
    });

    const { updateActionItemStatus } = await import('@agent/core');
    updateActionItemStatus({
      mission_id: FIX_MISSION,
      item_id: 'AI-TEAM-BLOCK',
      status: 'blocked',
      blocked_reason: 'owner contact missing',
    });

    const first = await trackPendingActionItemsOp({
      mission_id: FIX_MISSION,
      policy: basePolicy(),
    });
    const second = await trackPendingActionItemsOp({
      mission_id: FIX_MISSION,
      policy: basePolicy(),
    });
    const items = listActionItems(FIX_MISSION);
    const reminded = items.find((i) => i.item_id === 'AI-TEAM-1');

    expect(first.reminded.map((i) => i.item_id)).toEqual(['AI-TEAM-1']);
    expect(second.reminded.map((i) => i.item_id)).toEqual(['AI-TEAM-1']);
    expect(reminded?.reminders ?? []).toHaveLength(1);
    expect(items.find((i) => i.item_id === 'AI-TEAM-BLOCK')?.reminders ?? []).toHaveLength(0);
    expect(items.find((i) => i.item_id === 'AI-EXT-1')?.reminders ?? []).toHaveLength(0);
    expect(items.find((i) => i.item_id === 'AI-SELF-2')?.reminders ?? []).toHaveLength(0);
  });
});

describe('auditSpeakerFairnessOp', () => {
  beforeEach(() => {
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.MISSION_ID = FIX_MISSION;
    safeMkdir(path.join(MISSION_DIR, 'evidence'), { recursive: true });
    safeWriteFile(
      path.join(MISSION_DIR, 'mission-state.json'),
      JSON.stringify({
        mission_id: FIX_MISSION,
        tier: 'confidential',
        assigned_persona: 'ecosystem_architect',
      }),
    );
  });

  afterEach(() => {
    safeRmSync(MISSION_DIR, { recursive: true, force: true });
  });

  it('flags the warn case when one speaker dominates total share', () => {
    for (let i = 1; i <= 8; i++) {
      recordActionItem({
        item_id: `AI-DOM-${i}`,
        mission_id: FIX_MISSION,
        title: `dominant speaker drives this commitment ${i}`,
        assignee: { kind: 'team_member', label: 'Alice' },
        provenance: { speaker_label: 'Alice' },
      });
    }
    for (let i = 1; i <= 2; i++) {
      recordActionItem({
        item_id: `AI-OTHER-${i}`,
        mission_id: FIX_MISSION,
        title: `other speaker contributes a small commitment ${i}`,
        assignee: { kind: 'team_member', label: 'Bob' },
        provenance: { speaker_label: 'Bob' },
      });
    }
    const report = auditSpeakerFairnessOp({
      mission_id: FIX_MISSION,
      policy: basePolicy(),
    });
    expect(report.dominant_speaker).toBe('Alice');
    expect(report.warn).toBe(true);
    expect(report.warn_reason).toContain('Alice');
    expect(report.distribution[0].speaker).toBe('Alice');
  });

  it('does not warn when distribution is even', () => {
    for (let i = 1; i <= 5; i++) {
      recordActionItem({
        item_id: `AI-A-${i}`,
        mission_id: FIX_MISSION,
        title: `alice has a balanced share ${i}`,
        assignee: { kind: 'team_member', label: 'Alice' },
        provenance: { speaker_label: 'Alice' },
      });
      recordActionItem({
        item_id: `AI-B-${i}`,
        mission_id: FIX_MISSION,
        title: `bob has a balanced share ${i}`,
        assignee: { kind: 'team_member', label: 'Bob' },
        provenance: { speaker_label: 'Bob' },
      });
    }
    const report = auditSpeakerFairnessOp({
      mission_id: FIX_MISSION,
      policy: basePolicy(),
    });
    expect(report.warn).toBe(false);
    expect(report.warn_reason).toBeNull();
  });

  it('respects per-call threshold overrides', () => {
    for (let i = 1; i <= 6; i++) {
      recordActionItem({
        item_id: `AI-A-${i}`,
        mission_id: FIX_MISSION,
        title: `alice owns most of the queue ${i}`,
        assignee: { kind: 'team_member', label: 'Alice' },
        provenance: { speaker_label: 'Alice' },
      });
    }
    for (let i = 1; i <= 4; i++) {
      recordActionItem({
        item_id: `AI-B-${i}`,
        mission_id: FIX_MISSION,
        title: `bob owns the rest of the queue ${i}`,
        assignee: { kind: 'team_member', label: 'Bob' },
        provenance: { speaker_label: 'Bob' },
      });
    }
    const lenient = auditSpeakerFairnessOp({
      mission_id: FIX_MISSION,
      policy: basePolicy(),
      total_threshold: 0.9,
    });
    expect(lenient.warn).toBe(false);

    const strict = auditSpeakerFairnessOp({
      mission_id: FIX_MISSION,
      policy: basePolicy(),
      total_threshold: 0.5,
    });
    expect(strict.warn).toBe(true);
  });

  it('counts unattributed items separately', () => {
    recordActionItem({
      item_id: 'AI-NS-1',
      mission_id: FIX_MISSION,
      title: 'no speaker attribution attached to this item',
      assignee: { kind: 'team_member', label: 'Alice' },
    });
    const report = auditSpeakerFairnessOp({
      mission_id: FIX_MISSION,
      policy: basePolicy(),
    });
    expect(report.attributed_items).toBe(0);
    expect(report.unattributed_items).toBe(1);
    expect(report.dominant_speaker).toBeNull();
    expect(report.warn).toBe(false);
  });
});
