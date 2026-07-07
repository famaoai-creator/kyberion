import { describe, expect, it } from 'vitest';
import { composeCeoSurfaceSummary } from './ceo-surface-summary.js';
import type { OperatorHomeSummary } from './operator-home-summary.js';

function makeHomeSummary(): OperatorHomeSummary {
  return {
    generatedAt: '2026-07-06T09:00:00.000Z',
    status: 'attention',
    statusLabel: 'attention',
    statusDetail: 'pending approvals',
    counts: {
      activeMissions: 2,
      blockedMissions: 0,
      pendingApprovals: 1,
      clarificationQuestions: 0,
      unreadInbox: 1,
      totalInbox: 2,
    },
    activeMissions: [
      {
        missionId: 'MSN-PITCH-001',
        status: 'active',
        tier: 'public',
        missionType: 'presentation_production',
        goalSummary: '顧客向け提案書の作成',
        successCondition: 'レビュー済みPPTXが納品される',
        updatedAt: '2026-07-06T08:00:00.000Z',
        artifactKinds: ['deck'],
        artifactCount: 1,
      },
      {
        missionId: 'MSN-FIX-002',
        status: 'failed',
        tier: 'public',
        artifactKinds: [],
        artifactCount: 0,
      },
    ],
    pendingApprovals: [
      {
        id: 'APR-001',
        channel: 'slack',
        storageChannel: 'slack',
        title: '外部送付の承認',
        sourceText: '提案書を顧客へ送付してよいかご確認ください',
        requestedAt: '2026-07-06T08:30:00.000Z',
        requestedByContext: { missionId: 'MSN-PITCH-001' },
      } as never,
    ],
    inboxEntries: [
      {
        entry_id: 'INBOX-1',
        title: '提案書ドラフト',
        artifact_paths: ['active/missions/public/MSN-PITCH-001/evidence/deck.pptx'],
        summary: '初稿が完成しました',
        created_at: '2026-07-06T08:45:00.000Z',
        updated_at: '2026-07-06T08:45:00.000Z',
        status: 'unread',
        mission_id: 'MSN-PITCH-001',
      },
    ],
    costSummary: {
      totalTokens: 0,
      totalUsd: 0,
      entryCount: 0,
      missionCount: 0,
      overBudget: false,
      missionBreakdown: [],
    },
    nextAction: {
      title: '承認キューを確認してください',
      reason: '1件の承認が保留中です',
      next_action_type: 'surface_action',
    } as never,
  };
}

describe('ceo-surface-summary', () => {
  it('maps the operator home summary into the four CEO panes', () => {
    const summary = composeCeoSurfaceSummary({
      home: makeHomeSummary(),
      notifications: [
        {
          request_id: 'NTF-1',
          title: 'ゲート失敗',
          text: 'DECK_REVIEW_PASSED が未達です',
          status: 'attention',
          surface: 'presence',
          created_at: '2026-07-06T08:50:00.000Z',
        },
        { request_id: 'NTF-2', title: '完了通知', status: 'completed', created_at: '' },
      ],
      now: '2026-07-06T09:00:00.000Z',
    });

    expect(summary.intent_inbox).toHaveLength(2);
    expect(summary.intent_inbox[0]).toMatchObject({
      mission_id: 'MSN-PITCH-001',
      title: '顧客向け提案書の作成',
      status_ja: '進行中',
      attention_needed: false,
    });
    expect(summary.intent_inbox[1]).toMatchObject({
      status_ja: '要対応',
      attention_needed: true,
    });

    expect(summary.approval_queue).toHaveLength(1);
    expect(summary.approval_queue[0]).toMatchObject({
      id: 'APR-001',
      title: '外部送付の承認',
      mission_id: 'MSN-PITCH-001',
      channel: 'slack',
      storage_channel: 'slack',
    });

    expect(summary.outcome_feed).toHaveLength(1);
    expect(summary.outcome_feed[0]).toMatchObject({ entry_id: 'INBOX-1', status: 'unread' });

    // Only attention-class notifications become exceptions.
    expect(summary.exception_feed).toHaveLength(1);
    expect(summary.exception_feed[0]).toMatchObject({ id: 'NTF-1', title: 'ゲート失敗' });

    expect(summary.briefing.counts).toEqual({
      active_missions: 2,
      pending_approvals: 1,
      unread_outcomes: 1,
      exceptions: 1,
    });
    expect(summary.briefing.sentence_ja).toContain('ご承認待ちが1件');
    expect(summary.briefing.sentence_ja).toContain('ございます');
  });

  it('produces a calm briefing when nothing needs attention', () => {
    const home = makeHomeSummary();
    home.counts = { ...home.counts, activeMissions: 0, pendingApprovals: 0, unreadInbox: 0 };
    home.activeMissions = [];
    home.pendingApprovals = [];
    home.inboxEntries = [];

    const summary = composeCeoSurfaceSummary({ home, notifications: [] });
    expect(summary.briefing.sentence_ja).toBe('本日は特にご対応いただく案件はございません。');
  });

  it('never leaks internal machinery vocabulary into the briefing', () => {
    const summary = composeCeoSurfaceSummary({
      home: makeHomeSummary(),
      notifications: [],
    });
    const text = JSON.stringify(summary.briefing);
    for (const forbidden of ['actuator', 'ADF', 'pipeline', 'dispatch']) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
