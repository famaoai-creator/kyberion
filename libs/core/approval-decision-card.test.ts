import { describe, expect, it } from 'vitest';
import {
  buildDecisionCardContent,
  describeGateEscalations,
  effectiveInterventionLevel,
  renderDecisionCardExplanation,
  renderDecisionCardText,
  resolveInterventionLevel,
  resolveInterventionTiming,
  viewDecisionCard,
} from './approval-decision-card.js';
import type { ApprovalRequestRecord } from './approval-store.js';
import type { AutonomousOpsGateResult } from './autonomous-ops-gate.js';

const NOW = Date.parse('2026-09-28T03:00:00Z');

function gate(overrides: Partial<AutonomousOpsGateResult> = {}): AutonomousOpsGateResult {
  return {
    actionId: 'pr_merge_medium',
    decision: 'notify',
    allowed: true,
    score: 5,
    maxScore: 6,
    policyVersion: '1.1.0',
    executionMode: 'apply',
    reason: 'autonomous ops score 5/6 for pr_merge_medium',
    axes: { scope: 2, reversibility: 1, sensitivity: 1, confidence: 1 },
    shadow: false,
    escalations: [],
    highRiskPathMatches: [],
    vetoWindowMinutes: 120,
    ...overrides,
  };
}

function record(overrides: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    kind: 'channel-approval',
    storageChannel: 'autonomy',
    channel: 'chat-1',
    threadTs: '',
    correlationId: 'c',
    requestedBy: 'agent:test',
    requestedAt: new Date(NOW).toISOString(),
    status: 'pending',
    title: 'Merge PR 42',
    summary: 'Merge the refactor PR',
    ...overrides,
  } as ApprovalRequestRecord;
}

describe('intervention levels', () => {
  it('maps the gate decision to what the operator has to do', () => {
    expect(resolveInterventionLevel({ decision: 'auto' })).toBe('none');
    expect(resolveInterventionLevel({ decision: 'notify' })).toBe('fyi');
    expect(resolveInterventionLevel({ decision: 'notify', vetoWindowMinutes: 120 })).toBe('veto');
    expect(resolveInterventionLevel({ decision: 'approve', vetoWindowMinutes: 120 })).toBe(
      'decide'
    );
  });

  it('interrupts only when the operator blocks the work or a veto clock needs delivery', () => {
    expect(resolveInterventionTiming('decide')).toBe('immediate');
    expect(resolveInterventionTiming('decide', { blocking: false })).toBe('digest');
    expect(resolveInterventionTiming('veto', { blocking: false })).toBe('immediate');
    expect(resolveInterventionTiming('fyi')).toBe('digest');
    expect(resolveInterventionTiming('none')).toBe('digest');
  });

  it('reads legacy approvals and undelivered vetoes as decisions', () => {
    expect(effectiveInterventionLevel(record())).toBe('decide');
    expect(
      effectiveInterventionLevel(
        record({
          veto: {
            windowMinutes: 60,
            deliveryDeadlineAt: new Date(NOW - 1).toISOString(),
          },
        }),
        NOW
      )
    ).toBe('decide');
  });
});

describe('escalation reasons', () => {
  it('turns gate codes into sentences', () => {
    const reasons = describeGateEscalations(
      gate({
        decision: 'approve',
        escalations: ['high_risk_path', 'never_auto'],
        highRiskPathMatches: ['libs/core/secure-io.ts'],
        reason: 'x; never-auto class: dependency_major; y',
      }),
      'ja'
    );
    expect(reasons).toEqual([
      '重要なファイルを変更します: libs/core/secure-io.ts',
      '常に人が決める種類の操作です: dependency_major',
    ]);
  });

  it('falls back to the score when nothing escalated', () => {
    expect(describeGateEscalations(gate(), 'en')).toEqual(['Risk score 5/6']);
    expect(describeGateEscalations(gate({ decision: 'auto' }), 'en')).toEqual([]);
  });
});

describe('decision card view', () => {
  it('tells the operator a decision blocks only this work, and when it is withdrawn', () => {
    const view = viewDecisionCard(
      record({
        expiresAt: '2026-09-30T03:00:00Z',
        justification: { reason: 'legacy' },
        decisionCard: {
          level: 'decide',
          ask: 'Merge?',
          reasons: ['legacy'],
          reversible: false,
          timezone: 'Asia/Tokyo',
        },
      }),
      { now: NOW, locale: 'ja' }
    );
    expect(view.level).toBe('decide');
    expect(view.reversible).toBe(false);
    expect(view.reasons).toEqual(['legacy']);
    expect(view.ifNoResponse).toContain('止めたまま');
    expect(view.ifNoResponse).toBe(
      '判断があるまで、この作業は止めたままにします。その間も他の作業は進めます。9/30 12:00 を過ぎると取り下げます。'
    );
    expect(view.deadlineAt).toBe('2026-09-30T03:00:00Z');
    expect(view.actions.map((action) => action.kind)).toEqual([
      'approve',
      'revise',
      'reject',
      'explain',
    ]);
  });

  it('shows when a veto proceeds and labels the buttons for objecting', () => {
    const content = buildDecisionCardContent({
      gate: gate(),
      ask: 'Merge PR 42 into main?',
      recommendation: { choice: 'approve', rationale: 'CI green and cross-provider review passed' },
      evidence: ['https://example.invalid/pr/42'],
    });
    const view = viewDecisionCard(
      record({
        decisionCard: content,
        veto: {
          windowMinutes: 120,
          activeHours: { start: '09:00', end: '22:00', timezone: 'Asia/Tokyo' },
          deliveryDeadlineAt: new Date(NOW + 30 * 60_000).toISOString(),
          deliveredAt: new Date(NOW).toISOString(),
          proceedsAt: '2026-09-28T05:00:00.000Z',
        },
      }),
      { now: NOW, locale: 'ja' }
    );
    expect(view.level).toBe('veto');
    expect(view.reversible).toBe(true);
    expect(view.ifNoResponse).toBe('9/28 14:00 までに異議がなければ、自動で進めます。');
    expect(view.actions.find((action) => action.kind === 'reject')?.label).toBe('止める(異議)');

    const text = renderDecisionCardText(view, 'ja');
    const order = [
      '🟡',
      '決めてほしいこと',
      '推奨',
      '人の判断が必要な理由',
      '取り消し',
      '何もしない場合',
      '証跡',
      '返信',
    ];
    const positions = order.map((marker) => text.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('marks shadow cards and omits the reply hint for report-only cards', () => {
    const fyi = viewDecisionCard(
      record({
        decisionCard: { level: 'fyi', ask: 'Restarted a daemon', reasons: [], reversible: true },
      }),
      { now: NOW, locale: 'en' }
    );
    expect(renderDecisionCardText(fyi, 'en')).not.toContain('Reply:');
    expect(fyi.ifNoResponse).toContain('Nothing');

    const shadow = viewDecisionCard(
      record({
        decisionCard: { level: 'veto', ask: 'a', reasons: [], reversible: true, shadow: true },
        veto: {
          windowMinutes: 60,
          deliveryDeadlineAt: new Date(NOW + 60_000).toISOString(),
          shadow: true,
        },
      }),
      { now: NOW, locale: 'en' }
    );
    expect(renderDecisionCardText(shadow, 'en')).toContain('trial mode');
    expect(shadow.ifNoResponse).toContain('Trial mode');
  });

  it('explains without deciding', () => {
    const view = viewDecisionCard(record(), { now: NOW, locale: 'en' });
    const explanation = renderDecisionCardExplanation(view, 'en');
    expect(explanation).toContain('Why this reached you');
    expect(explanation).toContain('No policy escalation was recorded');
  });
});
