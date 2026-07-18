import { afterEach, describe, expect, it } from 'vitest';
import { safeRmSync } from './secure-io.js';
import {
  approvalRequestLogicalPath,
  createApprovalRequest,
  listApprovalRequests,
} from './approval-store.js';
import { withExecutionContext } from './authority.js';
import {
  applySurfaceApprovalDecision,
  buildSurfaceApprovalActions,
  buildSurfaceApprovalAskWhyActions,
  buildSurfaceApprovalText,
  createSurfaceApprovalRequest,
  resolveSurfaceApprovalAskWhy,
  resolveSurfaceApprovalReply,
} from './surface-approval-ui.js';
import { buildSlackApprovalAskWhyBlocks, parseSlackAskWhyAction } from './slack-approval-ui.js';

const RUN_ID = `${process.pid}-${Date.now()}`;
const FIXTURE_CHANNEL = `test-${RUN_ID}`.slice(0, 63);

afterEach(() => {
  withExecutionContext('surface_runtime', () => {
    try {
      for (const surface of ['slack', 'telegram', 'discord'] as const) {
        withExecutionContext(surface === 'slack' ? 'slack_bridge' : 'surface_runtime', () => {
          for (const record of listApprovalRequests({ storageChannels: [surface] })) {
            if (record.correlationId.startsWith(`surface-approval-test-${RUN_ID}`)) {
              safeRmSync(approvalRequestLogicalPath(surface, record.id), { force: true });
            }
          }
        });
      }
      withExecutionContext('mission_controller', () => {
        for (const record of listApprovalRequests({ storageChannels: ['background-review'] })) {
          if (record.correlationId.startsWith(`surface-approval-test-${RUN_ID}`)) {
            safeRmSync(approvalRequestLogicalPath('background-review', record.id), { force: true });
          }
        }
      });
    } catch {
      // Best-effort fixture cleanup.
    }
  });
});

describe('surface-approval-ui', () => {
  it('renders a portable numbered fallback and applies an unambiguous decision', () => {
    const record = createSurfaceApprovalRequest({
      surface: 'telegram',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-1',
      correlationId: `surface-approval-test-${RUN_ID}-1`,
      requestedBy: 'agent-1',
      draft: { title: 'Deploy', summary: 'Deploy the reviewed change.' },
    });
    expect(buildSurfaceApprovalText('telegram', record)).toContain('1: 承認する');
    expect(buildSurfaceApprovalText('telegram', record)).toContain(`appr:${record.id}:approve`);
    expect(buildSurfaceApprovalActions(record).map((action) => action.callbackData)).toEqual([
      `appr:${record.id}:approve`,
      `appr:${record.id}:reject`,
    ]);

    const result = resolveSurfaceApprovalReply({
      surface: 'telegram',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-1',
      text: '1',
      decidedBy: 'human-1',
    });
    expect(result).toMatchObject({ handled: true, record: { status: 'approved' } });
  });

  it('fails closed and durably expires stale or malformed approval requests', () => {
    const expired = createSurfaceApprovalRequest({
      surface: 'telegram',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-expired',
      correlationId: `surface-approval-test-${RUN_ID}-expired`,
      requestedBy: 'agent-1',
      expiresAt: '2000-01-01T00:00:00.000Z',
      draft: { title: 'Expired deploy', summary: 'Must not be approved.' },
    });
    const expiredReply = resolveSurfaceApprovalReply({
      surface: 'telegram',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-expired',
      text: `appr:${expired.id}:approve`,
      decidedBy: 'human-1',
    });
    expect(expiredReply).toMatchObject({
      handled: true,
      reply: 'この承認要求は期限切れです。',
      record: { status: 'expired' },
    });

    const malformed = createSurfaceApprovalRequest({
      surface: 'telegram',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-malformed-expiry',
      correlationId: `surface-approval-test-${RUN_ID}-malformed-expiry`,
      requestedBy: 'agent-1',
      expiresAt: 'not-a-timestamp',
      draft: { title: 'Malformed expiry', summary: 'Must also fail closed.' },
    });
    expect(() =>
      applySurfaceApprovalDecision({
        surface: 'telegram',
        requestId: malformed.id,
        decision: 'approved',
        channel: FIXTURE_CHANNEL,
        threadTs: 'thread-malformed-expiry',
        decidedBy: 'human-1',
      })
    ).toThrow('[POLICY_VIOLATION] Approval request has expired');
  });

  it('does not let a bare decision cross channel or thread boundaries', () => {
    createSurfaceApprovalRequest({
      surface: 'discord',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-2',
      correlationId: `surface-approval-test-${RUN_ID}-2`,
      requestedBy: 'agent-1',
      draft: { title: 'Deploy', summary: 'Deploy the reviewed change.' },
    });
    const result = resolveSurfaceApprovalReply({
      surface: 'discord',
      channel: `${FIXTURE_CHANNEL}-other`,
      threadTs: 'thread-1',
      text: '2',
      decidedBy: 'human-1',
    });
    expect(result).toEqual({
      handled: true,
      reply: 'このスレッドに処理待ちの承認要求はありません。',
    });
  });

  it('accepts the same callback token used by native buttons', () => {
    const record = createSurfaceApprovalRequest({
      surface: 'discord',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-3',
      correlationId: `surface-approval-test-${RUN_ID}-3`,
      requestedBy: 'agent-1',
      draft: { title: 'Rotate key', summary: 'Rotate the approved key.' },
    });
    const result = resolveSurfaceApprovalReply({
      surface: 'discord',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-3',
      text: `appr:${record.id}:reject`,
      decidedBy: 'human-2',
    });
    expect(result).toMatchObject({ handled: true, record: { status: 'rejected' } });
  });

  it('resolves a Presence token and ask-why against background-review storage', () => {
    const record = withExecutionContext('mission_controller', () =>
      createApprovalRequest('mission_controller', {
        channel: FIXTURE_CHANNEL,
        storageChannel: 'background-review',
        threadTs: 'thread-presence',
        correlationId: `surface-approval-test-${RUN_ID}-presence`,
        requestedBy: 'background-review-fork',
        draft: { title: 'Review proposal', summary: 'Apply the reviewed proposal.' },
        accountability: { finalDecision: 'human_only' },
      })
    );

    const decision = resolveSurfaceApprovalReply({
      surface: 'presence',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-presence',
      text: `appr:${record.id}:reject`,
      decidedBy: 'human-presence',
    });
    expect(decision).toMatchObject({ handled: true, record: { status: 'rejected' } });

    const reason = resolveSurfaceApprovalAskWhy({
      surface: 'presence',
      requestId: record.id,
      category: 'quality',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-presence',
      annotatedBy: 'human-presence',
    });
    expect(reason).toMatchObject({
      handled: true,
      record: { status: 'rejected' },
    });
    expect(reason.reply).toContain('quality');
  });

  it('routes Slack ask-why through the shared vocabulary and exact thread scope', () => {
    const record = createSurfaceApprovalRequest({
      surface: 'slack',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-4',
      correlationId: `surface-approval-test-${RUN_ID}-4`,
      requestedBy: 'agent-1',
      draft: { title: 'Deploy', summary: 'Deploy the reviewed change.' },
    });
    expect(() =>
      applySurfaceApprovalDecision({
        surface: 'slack',
        requestId: record.id,
        decision: 'rejected',
        channel: FIXTURE_CHANNEL,
        threadTs: 'other-thread',
        decidedBy: 'human-3',
      })
    ).toThrow('[POLICY_VIOLATION]');
    const decision = applySurfaceApprovalDecision({
      surface: 'slack',
      requestId: record.id,
      decision: 'rejected',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-4',
      decidedBy: 'human-3',
    });
    expect(decision).toMatchObject({ status: 'rejected' });

    expect(buildSurfaceApprovalAskWhyActions(record.id).map((action) => action.category)).toEqual([
      'incorrect_content',
      'wrong_direction',
      'quality',
      'scope',
      'other',
      'skip',
    ]);
    const slackAskWhyButtons = buildSlackApprovalAskWhyBlocks(record.id)[1].elements;
    expect(slackAskWhyButtons).toHaveLength(6);
    expect(
      slackAskWhyButtons.map((button: any) => parseSlackAskWhyAction(button.value).category)
    ).toEqual(['incorrect_content', 'wrong_direction', 'quality', 'scope', 'other', 'skip']);
    const wrongThread = resolveSurfaceApprovalAskWhy({
      surface: 'slack',
      requestId: record.id,
      category: 'quality',
      channel: FIXTURE_CHANNEL,
      threadTs: 'other-thread',
      annotatedBy: 'human-3',
    });
    expect(wrongThread.reply).toContain('別のスレッド');

    const reason = resolveSurfaceApprovalAskWhy({
      surface: 'slack',
      requestId: record.id,
      category: 'quality',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-4',
      annotatedBy: 'human-3',
    });
    expect(reason).toMatchObject({
      handled: true,
      record: { status: 'rejected' },
    });
    expect(reason.reply).toContain('quality');
  });
});
