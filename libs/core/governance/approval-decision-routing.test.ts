import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notifications = vi.hoisted(() => ({
  prefs: {} as Record<string, unknown>,
  notifyOperatorSync: vi.fn(() => true),
}));
vi.mock('../surface/operator-notifications.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../surface/operator-notifications.js')>();
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
import { withExecutionContext } from '../authority.js';
import type { AutonomousOpsGateResult } from './autonomous-ops-gate.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeRmSync } from '../secure-io.js';
import { resolveSurfaceApprovalReply } from '../surface/surface-approval-ui.js';

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
    question: 'Merge PR 42 into main?',
    requestedBy: 'agent:test',
    recommendation: 'Approve: CI green',
    locale: 'ja',
  });
}

function routedReasonsLine(requestId: string): string {
  return loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, requestId)!.decisionCard!.riskReasons[0];
}

// These assertions pin the Japanese rendering, so the locale is explicit rather
// than inherited from the host environment.
process.env.KYBERION_LOCALE = 'ja';

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

  // The notice log is append-only and shared by every file in this pool, so
  // assert only on what the test itself appended, never on an empty store.
  const noticesAppendedBy = (act: () => unknown) => {
    const before = listAutonomousActionNotices().length;
    act();
    return listAutonomousActionNotices().slice(before);
  };

  it('lets the agent proceed on auto and leaves a notice for the digest', () => {
    let routed: ReturnType<typeof route> | undefined;
    const appended = noticesAppendedBy(() => {
      routed = route({ decision: 'auto', vetoWindowMinutes: undefined });
    });
    expect(routed).toMatchObject({ level: 'none', proceed: true, parked: false, notified: false });
    expect(notifications.notifyOperatorSync).not.toHaveBeenCalled();
    expect(appended.map((notice) => notice.title)).toEqual(['Merge PR 42']);
  });

  it('never proceeds in shadow mode and reports nothing as done', () => {
    let routed: ReturnType<typeof route> | undefined;
    const appended = noticesAppendedBy(() => {
      routed = route({ decision: 'auto', allowed: false, shadow: true });
    });
    expect(routed?.proceed).toBe(false);
    expect(appended).toEqual([]);
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

  it('delivers to a caller-owned route and defers it to the inbox in quiet hours', () => {
    const quietHours = { start: '00:00', end: '23:59', timezone: 'UTC' };
    const routed = routeAutonomousDecision({
      role: 'mission_controller',
      gate: gate(),
      title: 'Dot proposal',
      question: 'Run the overdue tick?',
      recommendation: 'Approve',
      requestedBy: 'dot:org-ops',
      notificationRoute: { surface: 'slack', target: 'C-EXEC' },
      quietHours,
      now: Date.parse('2026-10-04T12:00:00Z'),
    });
    const stored = loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, routed.requestId!);
    // Quiet hours win over the caller route, never the operator's default channel.
    expect(stored?.decisionCard?.deliveredVia).toEqual({ surface: 'inbox', target: 'quiet-hours' });
    const [, , options] = notifications.notifyOperatorSync.mock.calls[0] as unknown as [
      string,
      unknown,
      { route: unknown; quietHours: unknown },
    ];
    expect(options).toEqual({ route: { surface: 'slack', target: 'C-EXEC' }, quietHours });
  });

  it('neutralizes agent-written markup for the surface the card is sent to', () => {
    const hostileTitle = 'Merge [PR 42](https://evil.invalid) <!channel>';
    const send = (surface: 'slack' | 'telegram') => {
      notifications.prefs = { default_channel: { surface, target: CHAT } };
      notifications.notifyOperatorSync.mockClear();
      routeAutonomousDecision({
        role: 'mission_controller',
        gate: gate(),
        title: hostileTitle,
        question: 'Merge <!here> now?',
        recommendation: 'Approve',
        requestedBy: 'agent:test',
      });
      return notifications.notifyOperatorSync.mock.calls[0] as unknown as [
        string,
        { title: string; body: string },
      ];
    };
    const [, slack] = send('slack');
    expect(slack.title).toContain('&lt;!channel&gt;');
    expect(slack.body).toContain('&lt;!here&gt;');
    expect(slack.body).not.toContain('<!here>');
    const [, telegram] = send('telegram');
    expect(telegram.title).toContain('\\[PR 42]');
  });

  it('counts an iMessage hand-off as delivery because it is sent synchronously', () => {
    notifications.prefs = {
      default_channel: { surface: 'imessage', target: 'me@example.invalid' },
    };
    const routed = route();
    const stored = loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, routed.requestId!);
    expect(stored?.veto?.deliveredAt).toBeTruthy();
  });

  it('cannot lower the human-only floor through extra runtime accountability fields', () => {
    const forged = {
      payloadHash: 'a'.repeat(64),
      effectBinding: 'fixture-effect',
      finalDecision: 'ai_only',
    };
    const routed = routeAutonomousDecision({
      role: 'mission_controller',
      gate: gate({ decision: 'approve', allowed: false }),
      title: 'Fixture',
      question: 'Fixed effect?',
      recommendation: 'Review',
      requestedBy: 'dot:fixture',
      accountability: forged,
    });
    expect(
      loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, routed.requestId!)?.accountability
    ).toEqual({
      payloadHash: forged.payloadHash,
      effectBinding: forged.effectBinding,
      finalDecision: 'human_only',
      min_assurance: 'A2',
    });
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

  it('parks a recurring caller on its pending request instead of ringing again', () => {
    const input = {
      role: 'mission_controller' as const,
      gate: gate({ decision: 'approve', allowed: false, actionId: 'daemon_restart' }),
      title: 'Restart scheduler',
      question: 'Restart the scheduler daemon?',
      recommendation: 'Approve: heartbeat stale',
      requestedBy: 'daemon_watchdog',
      dedupeKey: 'scheduler',
    };
    const first = routeAutonomousDecision(input);
    const second = routeAutonomousDecision({ ...input, now: Date.now() + 60_000 });
    expect(first).toMatchObject({ parked: true, notified: true });
    expect(first.reused).toBeUndefined();
    expect(second).toMatchObject({
      parked: true,
      proceed: false,
      notified: false,
      reused: true,
      requestId: first.requestId,
    });
    expect(notifications.notifyOperatorSync).toHaveBeenCalledTimes(1);
  });

  it('holds a non-blocking decision for the digest', () => {
    const routed = routeAutonomousDecision({
      role: 'mission_controller',
      gate: gate({ decision: 'approve', allowed: false }),
      title: 'Naming question',
      question: 'Which name?',
      recommendation: 'Either works',
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

    it('asks for instructions, then records them as a change request', () => {
      const { requestId } = route({ decision: 'approve', allowed: false });
      const prompt = reply(`appr:${requestId}:changes`);
      expect(prompt.forceReply).toBe(true);
      expect(prompt.reply).toContain(`appr:${requestId}:changes`);
      // `revise` is an alias of `changes`.
      const answer = reply(`appr:${requestId}:revise テストを先に足してください`);
      expect(answer.reply).toContain('Merge PR 42');
      expect(answer.record).toMatchObject({
        status: 'rejected',
        decidedByType: 'human',
        changeRequest: { instruction: 'テストを先に足してください' },
      });
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

  it('parses change instructions in linear time on adversarial whitespace', () => {
    const { requestId } = route({ decision: 'approve', allowed: false });
    const hostile = `appr:${requestId}:changes${' \t'.repeat(50_000)}x${' '.repeat(50_000)}!`;
    const started = performance.now();
    const answer = resolveSurfaceApprovalReply({
      surface: 'telegram',
      channel: CHAT,
      threadTs: CHAT,
      text: hostile,
      decidedBy: 'operator-1',
    });
    expect(performance.now() - started).toBeLessThan(1000);
    // Longer than the 2000-character instruction limit: refused, still pending.
    expect(answer.record?.status).toBe('pending');
  });
});
