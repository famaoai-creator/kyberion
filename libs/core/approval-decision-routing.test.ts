import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notifications = vi.hoisted(() => ({
  prefs: {} as Record<string, unknown>,
  notifyOperatorSync: vi.fn(() => true),
}));
vi.mock('./operator-notifications.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./operator-notifications.js')>();
  return {
    ...actual,
    loadNotificationPreferences: () => notifications.prefs,
    notifyOperatorSync: notifications.notifyOperatorSync,
  };
});

import { AUTONOMY_APPROVAL_CHANNEL } from './approval-decision-card.js';
import { routeAutonomousDecision } from './approval-decision-routing.js';
import { listAutonomousActionNotices } from './approval-digest.js';
import { approvalStoreRoots, loadApprovalRequest } from './approval-store.js';
import {
  approvalDeliveryCorrelationId,
  recordApprovalDeliveryReceipt,
} from './approval-veto-window.js';
import { withExecutionContext } from './authority.js';
import type { AutonomousOpsGateResult } from './autonomous-ops-gate.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeRmSync } from './secure-io.js';
import { parseDecisionToken, resolveSurfaceApprovalReply } from './surface-approval-ui.js';

const CHAT = '424242';

function gate(overrides: Partial<AutonomousOpsGateResult> = {}): AutonomousOpsGateResult {
  return {
    actionId: 'pr_merge_medium',
    decision: 'notify',
    allowed: true,
    score: 5,
    maxScore: 6,
    policyVersion: '1.1.0',
    executionMode: 'apply',
    reason: 'autonomous ops score 5/6',
    axes: { scope: 2, reversibility: 1, sensitivity: 1, confidence: 1 },
    shadow: false,
    escalations: [],
    highRiskPathMatches: [],
    vetoWindowMinutes: 120,
    ...overrides,
  };
}

function route(overrides: Partial<AutonomousOpsGateResult> = {}) {
  return routeAutonomousDecision({
    role: 'mission_controller',
    gate: gate(overrides),
    title: 'Merge PR 42',
    ask: 'Merge PR 42 into main?',
    requestedBy: 'agent:test',
    recommendation: { choice: 'approve', rationale: 'CI green' },
    locale: 'ja',
  });
}

function routedReasonsLine(requestId: string): string {
  return loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, requestId)!.decisionCard!.reasons[0];
}

describe('routeAutonomousDecision', () => {
  beforeEach(() => {
    notifications.prefs = { default_channel: { surface: 'telegram', target: CHAT } };
    notifications.notifyOperatorSync.mockClear();
  });

  afterEach(() => {
    withExecutionContext('mission_controller', () => {
      for (const root of Object.values(approvalStoreRoots())) {
        const dir = pathResolver.rootResolve(`${root}/${AUTONOMY_APPROVAL_CHANNEL}`);
        if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('lets the agent proceed on auto and leaves a notice for the digest', () => {
    const routed = route({ decision: 'auto', vetoWindowMinutes: undefined });
    expect(routed).toMatchObject({ level: 'none', proceed: true, parked: false, notified: false });
    expect(notifications.notifyOperatorSync).not.toHaveBeenCalled();
    expect(listAutonomousActionNotices().map((notice) => notice.title)).toEqual(['Merge PR 42']);
  });

  it('never proceeds in shadow mode and reports nothing as done', () => {
    const routed = route({ decision: 'auto', allowed: false, shadow: true });
    expect(routed.proceed).toBe(false);
    expect(listAutonomousActionNotices()).toEqual([]);
  });

  it('parks a veto, pushes the card once and starts the clock only on delivery', () => {
    const routed = route();
    expect(routed).toMatchObject({ level: 'veto', proceed: false, parked: true, notified: true });
    expect(notifications.notifyOperatorSync).toHaveBeenCalledTimes(1);
    const [event, payload] = notifications.notifyOperatorSync.mock.calls[0] as unknown as [
      string,
      { body: string; correlation_id: string },
    ];
    expect(event).toBe('approval_required');
    expect(payload.body).toContain('異議がなければ進めます');

    const stored = loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, routed.requestId!);
    expect(stored?.accountability).toBeUndefined();
    expect(stored?.decisionCard?.deliveredVia).toEqual({ surface: 'telegram', target: CHAT });
    expect(stored?.veto?.deliveredAt).toBeUndefined();
    expect(payload.correlation_id).toBe(approvalDeliveryCorrelationId(stored!));

    recordApprovalDeliveryReceipt({ correlation_id: payload.correlation_id });
    expect(
      loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, routed.requestId!)?.veto?.proceedsAt
    ).toBeTruthy();
  });

  it('counts an iMessage hand-off as delivery because it is sent synchronously', () => {
    notifications.prefs = {
      default_channel: { surface: 'imessage', target: 'me@example.invalid' },
    };
    const routed = route();
    const stored = loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, routed.requestId!);
    expect(stored?.veto?.deliveredAt).toBeTruthy();
  });

  it('keeps a decide request a human-only decision that expires instead of hanging', () => {
    const routed = route({
      decision: 'approve',
      allowed: false,
      escalations: ['high_risk_path'],
      highRiskPathMatches: ['libs/core/secure-io.ts'],
    });
    expect(routed).toMatchObject({ level: 'decide', parked: true, timing: 'immediate' });
    const stored = loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, routed.requestId!);
    expect(stored?.accountability?.finalDecision).toBe('human_only');
    expect(stored?.expiresAt).toBeTruthy();
    expect(stored?.veto).toBeUndefined();
    expect(routed.card?.reasons).toEqual(['重要なファイルを変更します: libs/core/secure-io.ts']);
  });

  it('holds a non-blocking decision for the digest', () => {
    const routed = routeAutonomousDecision({
      role: 'mission_controller',
      gate: gate({ decision: 'approve', allowed: false }),
      title: 'Naming question',
      ask: 'Which name?',
      requestedBy: 'agent:test',
      blocking: false,
    });
    expect(routed.timing).toBe('digest');
    expect(notifications.notifyOperatorSync).not.toHaveBeenCalled();
  });

  describe('replies from the surface the card was delivered to', () => {
    function reply(text: string, channel = CHAT) {
      return resolveSurfaceApprovalReply({
        surface: 'telegram',
        channel,
        threadTs: channel,
        text,
        decidedBy: 'operator-1',
      });
    }

    it('explains without deciding', () => {
      const { requestId } = route({
        decision: 'approve',
        allowed: false,
        escalations: ['requested'],
      });
      const answer = reply(`appr:${requestId}:explain`);
      expect(answer.reply).toContain(routedReasonsLine(requestId!));
      expect(loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, requestId!)?.status).toBe('pending');
    });

    it('asks for instructions, then records a change request as the decision note', () => {
      const { requestId } = route({ decision: 'approve', allowed: false });
      expect(reply(`appr:${requestId}:revise`).reply).toContain(`appr:${requestId}:revise`);
      const answer = reply(`appr:${requestId}:revise テストを先に足してください`);
      expect(answer.reply).toContain('Merge PR 42');
      expect(answer.record).toMatchObject({ status: 'rejected', decidedByType: 'human' });
    });

    it('approves a human-only decision from the delivering chat', () => {
      const { requestId } = route({ decision: 'approve', allowed: false });
      expect(reply(`appr:${requestId}:approve`).record?.status).toBe('approved');
    });

    it('accepts a bare Japanese objection when one card is pending in the chat', () => {
      const { requestId } = route();
      expect(reply('異議').record?.id).toBe(requestId);
      expect(loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, requestId!)?.status).toBe('rejected');
    });

    it('refuses replies from another chat', () => {
      const { requestId } = route({ decision: 'approve', allowed: false });
      expect(reply(`appr:${requestId}:approve`, '999').reply).toBe(
        'この承認要求は別のスレッドにあります。'
      );
      expect(reply(`appr:${requestId}:explain`, '999').record).toBeUndefined();
      expect(loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, requestId!)?.status).toBe('pending');
    });
  });

  describe('parseDecisionToken', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';

    it('splits the verb from free-text instructions', () => {
      expect(parseDecisionToken(`appr:${id}:REVISE  add tests\nfirst`)).toEqual({
        requestId: id,
        verb: 'revise',
        trailing: 'add tests\nfirst',
      });
      expect(parseDecisionToken(`appr:${id}:approve`)).toEqual({ requestId: id, verb: 'approve' });
      expect(parseDecisionToken(`appr:${id}:approvex`)).toBeNull();
      expect(parseDecisionToken(`appr:${id}:why:quality`)).toBeNull();
    });

    it('stays linear on adversarial whitespace', () => {
      const hostile = `appr:${id}:revise${' \t'.repeat(50_000)}x${' '.repeat(50_000)}!`;
      const started = performance.now();
      expect(parseDecisionToken(hostile)?.trailing?.endsWith('!')).toBe(true);
      expect(performance.now() - started).toBeLessThan(500);
    });
  });
});
