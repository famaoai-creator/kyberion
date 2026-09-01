import { afterEach, describe, expect, it } from 'vitest';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  createApprovalRequest,
  decideApprovalRequest,
  listApprovalRequests,
  loadApprovalRequest,
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
      for (const surface of ['slack', 'telegram', 'discord', 'brief'] as const) {
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

interface ApprovalEventLine {
  event?: string;
  request_id?: string;
  reason_category?: string;
  note?: string;
}

function readApprovalEvents(storageChannel: string): ApprovalEventLine[] {
  return withExecutionContext('surface_runtime', () => {
    const eventPath = pathResolver.resolve(approvalEventLogicalPath(storageChannel));
    if (!safeExistsSync(eventPath)) return [];
    return (safeReadFile(eventPath, { encoding: 'utf8' }) as string)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ApprovalEventLine);
  });
}

describe('surface-approval-ui MO-11 cross-surface coherence', () => {
  it('rejects the brief surface for human_only final approval (S-3)', () => {
    const record = createSurfaceApprovalRequest({
      surface: 'brief',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-brief',
      correlationId: `surface-approval-test-${RUN_ID}-brief`,
      requestedBy: 'planner',
      draft: { title: 'ミッションブリーフ', summary: 'アラインメント承認' },
    });

    expect(() =>
      applySurfaceApprovalDecision({
        surface: 'brief',
        requestId: record.id,
        decision: 'approved',
        channel: FIXTURE_CHANNEL,
        threadTs: 'thread-brief',
        decidedBy: 'sovereign',
      })
    ).toThrow(/local_token is not sufficient/u);

    expect(loadApprovalRequest('brief', record.id)?.status).toBe('pending');
  });

  it('does not invent an auth strength for other surfaces (S-3 regression guard)', () => {
    const record = createSurfaceApprovalRequest({
      surface: 'telegram',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-strong',
      correlationId: `surface-approval-test-${RUN_ID}-strong`,
      requestedBy: 'agent-1',
      draft: { title: 'Deploy', summary: 'Deploy the reviewed change.' },
    });
    const decided = applySurfaceApprovalDecision({
      surface: 'telegram',
      requestId: record.id,
      decision: 'approved',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-strong',
      decidedBy: 'human-1',
    });
    // Unchanged from before MO-11: claiming surface_session for every surface
    // would be the same dishonesty as claiming it for brief.
    expect(decided.decidedAuthMethod).toBeUndefined();

    // An explicit caller that knows its own strength still wins.
    const explicit = createSurfaceApprovalRequest({
      surface: 'telegram',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-explicit',
      correlationId: `surface-approval-test-${RUN_ID}-explicit`,
      requestedBy: 'agent-1',
      draft: { title: 'Deploy', summary: 'Explicit auth method.' },
    });
    expect(
      applySurfaceApprovalDecision({
        surface: 'telegram',
        requestId: explicit.id,
        decision: 'approved',
        channel: FIXTURE_CHANNEL,
        threadTs: 'thread-explicit',
        decidedBy: 'human-1',
        authMethod: 'passkey',
      }).decidedAuthMethod
    ).toBe('passkey');
  });

  it('carries the rejection reason and note into the store, not just the call', () => {
    const record = createSurfaceApprovalRequest({
      surface: 'telegram',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-reason',
      correlationId: `surface-approval-test-${RUN_ID}-reason`,
      requestedBy: 'planner',
      draft: { title: 'ミッションブリーフ', summary: '要修正ループ' },
    });

    const decided = applySurfaceApprovalDecision({
      surface: 'telegram',
      requestId: record.id,
      decision: 'rejected',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-reason',
      decidedBy: 'sovereign',
      reasonCategory: 'scope',
      note: 'スコープが広すぎる',
    });

    expect(decided.status).toBe('rejected');
    expect(loadApprovalRequest('telegram', record.id)?.status).toBe('rejected');

    // LC-10: the rationale has to reach the event stream, which is what the
    // changes loop and the learning loops actually read. `note`/`reasonCategory`
    // were previously dropped on the floor here (spread args skip excess
    // property checks), making a brief rejection indistinguishable from a bare
    // "no" — assert the durable artifact, not just the return value.
    const event = readApprovalEvents('telegram').find(
      (entry) => entry.request_id === record.id && entry.event === 'rejected'
    );
    expect(event?.reason_category).toBe('scope');
    expect(event?.note).toBe('スコープが広すぎる');
  });

  it('refuses to flip a settled decision from another surface (S-4)', () => {
    const record = createSurfaceApprovalRequest({
      surface: 'telegram',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-settled',
      correlationId: `surface-approval-test-${RUN_ID}-settled`,
      requestedBy: 'agent-1',
      draft: { title: 'Deploy', summary: 'Approved on one surface first.' },
    });

    applySurfaceApprovalDecision({
      surface: 'telegram',
      requestId: record.id,
      decision: 'approved',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-settled',
      decidedBy: 'human-1',
    });

    // The concierge route reaches decideApprovalRequest directly rather than
    // through applySurfaceApprovalDecision, so the guard has to live in core.
    expect(() =>
      decideApprovalRequest('surface_runtime', {
        channel: FIXTURE_CHANNEL,
        storageChannel: 'telegram',
        requestId: record.id,
        decision: 'rejected',
        decidedBy: 'someone-else',
        decidedByType: 'human',
        authenticated: true,
      })
    ).toThrow(/already approved/u);

    const persisted = loadApprovalRequest('telegram', record.id);
    expect(persisted?.status).toBe('approved');
    expect(persisted?.decidedBy).toBe('human-1');
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

  it('keeps the shared intent authority and next action in approval text', () => {
    const record = createSurfaceApprovalRequest({
      surface: 'telegram',
      channel: FIXTURE_CHANNEL,
      threadTs: 'thread-contract',
      correlationId: `surface-approval-test-${RUN_ID}-contract`,
      requestedBy: 'agent-1',
      draft: { title: 'Deploy', summary: 'Deploy the reviewed change.' },
    });
    const text = buildSurfaceApprovalText('telegram', record, {
      request_id: 'ir_approval_contract',
      normalized_intent: 'deploy_release',
      missing_inputs: [],
      resolution_shape: 'mission',
      outcome_kind: 'service_change',
      authority_level: 'approval_required',
      next_action: {
        kind: 'request_approval',
        label: 'Approve this release.',
        consequence: 'The release waits until approval is recorded.',
      },
      rationale: 'approval is required',
    });

    expect(text).toContain('Authority: 人間の承認が必要');
    expect(text).toContain('Next action: Approve this release.');
    expect(text).toContain('Consequence: The release waits until approval is recorded.');
    expect(text).toContain('Outcome: サービス変更');
    expect(text).not.toContain('approval_required');
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
