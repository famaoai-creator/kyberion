import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile, safeRmSync } from './secure-io.js';
import {
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  releaseWorkItem,
  setWorkCoordinationNamespace,
} from './work-coordination.js';
import {
  createOrchestratorSession,
  getActiveSessionForMission,
  releaseOrchestratorSessionForMission,
  resetOrchestratorSessionServiceForTests,
} from './orchestrator-session.js';
import {
  approvalRequestLogicalPath,
  drainPendingSteeringApprovalExecutions,
  listApprovalRequests,
  loadApprovalRequest,
} from './approval-store.js';
import { resolveSurfaceApprovalReply } from './surface-approval-ui.js';
import { validateSurfaceUxContract } from './surface-ux-contract.js';
import {
  buildMissionLifecycleService,
  type MissionLifecycleUnderlyingSystem,
} from './mission-lifecycle-service.js';
import {
  buildMissionSteeringRouteHandler,
  classifySteeringMessage,
  setMissionSteeringLifecycleAdapterForTests,
  setMissionSteeringReconciliationBuilderForTests,
  type MissionSteeringLifecycleAdapter,
} from './surface-mission-steering.js';
import type { SurfaceConversationInput } from './channel-surface-types.js';
import type { SurfaceRuntimeRouteContext } from './surface-runtime-router.js';
import type { MissionStatusView } from './mission-read-model.js';

/**
 * SO-04 hermetic E2E tests. Hermetic like surface-steering-authority.test.ts:
 * unique orchestrator-session journal path + a dedicated work-coordination
 * namespace per test, never the governed defaults. The mission-lifecycle
 * verbs are stubbed at the `MissionLifecycleUnderlyingSystem` seam (via the
 * REAL `buildMissionLifecycleService`, so gating/audit/session-release-on-
 * finish all run for real) — no real mission filesystem/git I/O happens.
 * `resolveSurfaceApprovalReply` is the REAL, unmodified function bridges
 * call — this proves the fire-and-forget execution wiring in
 * approval-store.ts's `decideApprovalRequest` actually fires from the same
 * code path production traffic uses, not from a test-only shortcut.
 */

const RUN_ID = `${process.pid}-${Date.now()}`;

// Dedicated approval-storage surface: tests/channel-surface-agent.test.ts
// (and other suites) wipe the REAL shared 'slack' coordination dir in their
// beforeEach; running in parallel forks that would delete this suite's
// approval records mid-test. 'telegram' is (a) writable by the
// surface_runtime governed role (role-write-access.json — an invented
// surface name would fail the write-permission policy) and (b) only ever
// cleaned per-record by other suites (surface-approval-ui.test.ts), never
// dir-wiped. Channel/thread ids are RUN_ID-scoped below so records from
// parallel runs can never collide.
const STEERING_TEST_SURFACE = 'telegram';
const TMP_DIR = `active/shared/tmp/so04-steering-tests-${RUN_ID}`;
let journalCounter = 0;

function nextJournalPath(): string {
  journalCounter += 1;
  return `${TMP_DIR}/orchestrator-sessions-${journalCounter}.jsonl`;
}

function makeStubUnderlyingSystem(calls: string[]): MissionLifecycleUnderlyingSystem {
  return {
    create: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    createCheckpoint: vi.fn(async (taskId: string, note: string, missionId?: string) => {
      calls.push(`checkpoint:${missionId}:${note}`);
      return { ok: true };
    }),
    verifyMission: vi.fn(async (id: string, result: string, note: string) => {
      calls.push(`verify:${id}:${result}:${note}`);
      return undefined;
    }),
    finishMission: vi.fn(async (id: string, seal: boolean) => {
      calls.push(`finish:${id}:${seal}`);
      return undefined;
    }),
    staffMissionTeam: vi.fn(async () => ({ ok: true })),
    prewarmMissionTeam: vi.fn(async () => ({ status: 'queued' })),
    dispatchMissionWorkItems: vi.fn(async () => ({ ok: true })),
    pauseMission: vi.fn(async (id: string, note?: string) => {
      calls.push(`pause:${id}:${note}`);
      return undefined;
    }),
    resumeMission: vi.fn(async (id?: string) => {
      calls.push(`resume:${id}`);
      return undefined;
    }),
  } as unknown as MissionLifecycleUnderlyingSystem;
}

function fakeStatusView(missionId: string): MissionStatusView {
  return {
    state: {
      mission_id: missionId,
      status: 'active',
      history: [{ ts: new Date().toISOString(), event: 'START', note: 'started' }],
    },
    missionPath: null,
    nextAction: 'continue working',
    recentHistory: [{ ts: new Date().toISOString(), event: 'START', note: 'started' }],
  } as unknown as MissionStatusView;
}

function buildAdapter(
  facade: ReturnType<typeof buildMissionLifecycleService>
): MissionSteeringLifecycleAdapter {
  return {
    status: (id) => fakeStatusView(id),
    createCheckpoint: (taskId, note, missionId, options) =>
      facade.createCheckpoint(taskId, note, missionId, options),
    verify: (id, result, note, options) => facade.verify(id, result, note, options),
    finish: (id, seal, options) => facade.finish(id, seal, options),
    pause: (id, note, options) => facade.pause(id, note, options),
    resume: (id, options) => facade.resume(id, options),
  };
}

function buildContext(
  text: string,
  overrides: Partial<{ surface: string; channel: string; threadTs: string }> = {}
): SurfaceRuntimeRouteContext {
  const surface = overrides.surface ?? STEERING_TEST_SURFACE;
  const channel = `${overrides.channel ?? 'C1'}-${RUN_ID}`;
  const threadTs = `${overrides.threadTs ?? 'T1'}-${RUN_ID}`;
  const input: SurfaceConversationInput = {
    agentId: 'test-surface-agent',
    query: text,
    senderAgentId: 'tester',
    surface,
    surfaceMetadata: { surface, channel, threadTs } as SurfaceConversationInput['surfaceMetadata'],
  };
  return {
    input,
    compiledFlow: null,
    structuredQuery: text,
    parsedSlackPrompt: null,
  };
}

function extractApprovalRequestId(text: string): string {
  const match = text.match(/appr:([0-9a-f-]{36}):approve/i);
  if (!match) throw new Error(`no approval request id found in text: ${text}`);
  return match[1];
}

let calls: string[];

beforeEach(() => {
  setWorkCoordinationNamespace(`so04-steering-tests-${RUN_ID}`);
  clearWorkCoordinationStore();
  resetOrchestratorSessionServiceForTests(nextJournalPath());
  calls = [];
  const stubSystem = makeStubUnderlyingSystem(calls);
  const facade = buildMissionLifecycleService(stubSystem);
  setMissionSteeringLifecycleAdapterForTests(buildAdapter(facade));
});

afterEach(async () => {
  setMissionSteeringLifecycleAdapterForTests(null);
  setMissionSteeringReconciliationBuilderForTests(null);
  await drainPendingSteeringApprovalExecutions();
  // Approval requests this suite creates land in REAL governed storage
  // (active/shared/coordination/channels/slack/...), not the temp journal —
  // clean up by mission-id prefix, mirroring surface-approval-ui.test.ts's
  // fixture cleanup.
  try {
    withExecutionContext('surface_runtime', () => {
      for (const record of listApprovalRequests({ storageChannels: [STEERING_TEST_SURFACE] })) {
        if (record.source?.missionId?.startsWith('MSN-SO04-')) {
          safeRmSync(approvalRequestLogicalPath(STEERING_TEST_SURFACE, record.id), { force: true });
        }
      }
    });
  } catch {
    // Best-effort fixture cleanup.
  }
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
});

function createSession(overrides: {
  surface?: string;
  channel?: string;
  threadTs?: string;
  missionId: string;
}) {
  return withExecutionContext('mission_controller', () =>
    createOrchestratorSession({
      surface: overrides.surface ?? STEERING_TEST_SURFACE,
      channel: `${overrides.channel ?? 'C1'}-${RUN_ID}`,
      threadTs: `${overrides.threadTs ?? 'T1'}-${RUN_ID}`,
      missionId: overrides.missionId,
      ownerActor: 'steering-test-owner',
    })
  );
}

function satisfiedReconciliationBuilder() {
  return () => ({
    reconciliationInput: {
      goal: { summary: 'Ship the widget', success_condition: 'widget shipped' },
      evidenceTexts: ['widget shipped'],
    },
    completionGoal: { summary: 'Ship the widget', success_condition: 'widget shipped' },
    evidence: [],
    evidenceRefs: [],
  });
}

function unsatisfiedReconciliationBuilder() {
  return () => ({
    reconciliationInput: {
      goal: { summary: 'Ship the widget', success_condition: 'widget shipped and documented' },
      evidenceTexts: [],
    },
    completionGoal: {
      summary: 'Ship the widget',
      success_condition: 'widget shipped and documented',
    },
    evidence: [],
    evidenceRefs: [],
  });
}

describe('classifySteeringMessage', () => {
  it('matches the documented trigger phrases (Japanese + English) conservatively', () => {
    expect(classifySteeringMessage('ステータス')).toEqual({ verb: 'status', note: undefined });
    expect(classifySteeringMessage('status')).toEqual({ verb: 'status', note: undefined });
    expect(classifySteeringMessage('進捗')).toEqual({ verb: 'status', note: undefined });
    expect(classifySteeringMessage('一時停止')).toEqual({ verb: 'pause', note: undefined });
    expect(classifySteeringMessage('再開')).toEqual({ verb: 'resume', note: undefined });
    expect(classifySteeringMessage('承認')).toEqual({ verb: 'gate_approval', note: undefined });
    expect(classifySteeringMessage('approve gate')).toEqual({
      verb: 'gate_approval',
      note: undefined,
    });
    expect(classifySteeringMessage('完了にして')).toEqual({ verb: 'finish', note: undefined });
    expect(classifySteeringMessage('finish mission')).toEqual({ verb: 'finish', note: undefined });
    expect(classifySteeringMessage('チェックポイント: バグ修正完了')).toEqual({
      verb: 'checkpoint',
      note: 'バグ修正完了',
    });
    expect(classifySteeringMessage('checkpoint: fixed the bug')).toEqual({
      verb: 'checkpoint',
      note: 'fixed the bug',
    });
  });

  it('never false-positives on ordinary conversation', () => {
    expect(
      classifySteeringMessage('明日のミーティングのステータスについて聞きたいんだけど')
    ).toBeNull();
    expect(
      classifySteeringMessage('checkpointing my understanding here, is this right?')
    ).toBeNull();
    expect(classifySteeringMessage('この承認プロセスは長すぎると思う')).toBeNull();
    expect(classifySteeringMessage('let me know the finish line for the marathon')).toBeNull();
    expect(classifySteeringMessage('')).toBeNull();
  });
});

describe('surface-mission-steering route handler (SO-04)', () => {
  it('(c) does not match when the thread has no active orchestrator session', () => {
    const handler = buildMissionSteeringRouteHandler();
    for (const text of [
      'ステータス',
      'チェックポイント: メモ',
      '一時停止',
      '再開',
      '承認',
      '完了にして',
    ]) {
      const context = buildContext(text, {
        channel: 'no-session-channel',
        threadTs: 'no-session-thread',
      });
      expect(handler.matches(context)).toBe(false);
    }
  });

  it('(a) full flow: status -> checkpoint -> pause -> resume -> gate approval -> decision -> gate executes', async () => {
    const missionId = 'MSN-SO04-FULL-A';
    createSession({ missionId, channel: 'C-full', threadTs: 'T-full' });
    const handler = buildMissionSteeringRouteHandler();
    const at = (text: string) => buildContext(text, { channel: 'C-full', threadTs: 'T-full' });

    // status
    const statusCtx = at('ステータス');
    expect(handler.matches(statusCtx)).toBe(true);
    const statusResult = await handler.handle(statusCtx);
    expect(statusResult.text).toContain('状態');
    expect(validateSurfaceUxContract({ text: statusResult.text }).valid).toBe(true);

    // checkpoint
    const checkpointResult = await handler.handle(at('チェックポイント: バグ修正完了'));
    expect(calls).toContain(`checkpoint:${missionId}:バグ修正完了`);
    expect(validateSurfaceUxContract({ text: checkpointResult.text }).valid).toBe(true);

    // pause / resume (reversible, executed directly)
    const pauseResult = await handler.handle(at('一時停止'));
    expect(calls.some((c) => c.startsWith(`pause:${missionId}:`))).toBe(true);
    expect(validateSurfaceUxContract({ text: pauseResult.text }).valid).toBe(true);

    const resumeResult = await handler.handle(at('再開'));
    expect(calls).toContain(`resume:${missionId}`);
    expect(validateSurfaceUxContract({ text: resumeResult.text }).valid).toBe(true);

    // gate approval — irreversible, must NOT execute directly
    const gateRequestResult = await handler.handle(at('承認'));
    expect(validateSurfaceUxContract({ text: gateRequestResult.text }).valid).toBe(true);
    expect(calls.some((c) => c.startsWith('verify:'))).toBe(false);
    const gateRequestId = extractApprovalRequestId(gateRequestResult.text);
    const gateRecordBeforeDecision = loadApprovalRequest(STEERING_TEST_SURFACE, gateRequestId);
    expect(gateRecordBeforeDecision?.steering).toMatchObject({
      kind: 'mission_lifecycle_verb',
      verb: 'verify',
      missionId,
    });
    expect(gateRecordBeforeDecision?.status).toBe('pending');

    // decision arrives through the SAME unmodified path every bridge calls.
    const gateDecision = await resolveSurfaceApprovalReply({
      surface: STEERING_TEST_SURFACE,
      channel: `C-full-${RUN_ID}`,
      threadTs: `T-full-${RUN_ID}`,
      text: `appr:${gateRequestId}:approve`,
      decidedBy: 'human-operator',
    });
    expect(gateDecision).toMatchObject({ handled: true, record: { status: 'approved' } });
    await drainPendingSteeringApprovalExecutions();
    expect(
      calls.some((c) => c === `verify:${missionId}:verified:surface steering gate approval`)
    ).toBe(true);
    const gateRecordAfterExecution = loadApprovalRequest(STEERING_TEST_SURFACE, gateRequestId);
    expect(gateRecordAfterExecution?.applyResult?.result).toBe('success');

    // finish — irreversible, IL-04 satisfied
    setMissionSteeringReconciliationBuilderForTests(satisfiedReconciliationBuilder());
    const finishRequestResult = await handler.handle(at('完了にして'));
    expect(validateSurfaceUxContract({ text: finishRequestResult.text }).valid).toBe(true);
    expect(calls.some((c) => c.startsWith('finish:'))).toBe(false);
    const finishRequestId = extractApprovalRequestId(finishRequestResult.text);
    expect(loadApprovalRequest(STEERING_TEST_SURFACE, finishRequestId)?.steering?.verb).toBe(
      'finish'
    );

    expect(getActiveSessionForMission(missionId)).not.toBeNull();
    const finishDecision = await resolveSurfaceApprovalReply({
      surface: STEERING_TEST_SURFACE,
      channel: `C-full-${RUN_ID}`,
      threadTs: `T-full-${RUN_ID}`,
      text: `appr:${finishRequestId}:approve`,
      decidedBy: 'human-operator',
    });
    expect(finishDecision).toMatchObject({ handled: true, record: { status: 'approved' } });
    await drainPendingSteeringApprovalExecutions();
    expect(calls).toContain(`finish:${missionId}:false`);
    // SO-02 hook: finish releases the orchestrator session.
    expect(getActiveSessionForMission(missionId)).toBeNull();
  });

  it('(a2) an approved decision does NOT execute when the thread lost ownership between request and decision', async () => {
    const missionId = 'MSN-SO04-STALE-A2';
    createSession({ missionId, channel: 'C-stale', threadTs: 'T-stale' });
    const handler = buildMissionSteeringRouteHandler();

    // Request the irreversible gate approval while still the owner.
    const gateRequestResult = await handler.handle(
      buildContext('承認', { channel: 'C-stale', threadTs: 'T-stale' })
    );
    const gateRequestId = extractApprovalRequestId(gateRequestResult.text);
    expect(loadApprovalRequest(STEERING_TEST_SURFACE, gateRequestId)?.status).toBe('pending');

    // Ownership moves away before the human decides (e.g. handoff to CLI).
    withExecutionContext('mission_controller', () =>
      releaseOrchestratorSessionForMission(missionId, 'handoff')
    );

    // The decision still resolves (human approved a pending request)…
    const decision = await resolveSurfaceApprovalReply({
      surface: STEERING_TEST_SURFACE,
      channel: `C-stale-${RUN_ID}`,
      threadTs: `T-stale-${RUN_ID}`,
      text: `appr:${gateRequestId}:approve`,
      decidedBy: 'human-operator',
    });
    expect(decision).toMatchObject({ handled: true, record: { status: 'approved' } });
    await drainPendingSteeringApprovalExecutions();

    // …but the verb never executes, and the apply outcome records the loss.
    expect(calls.some((c) => c.startsWith('verify:'))).toBe(false);
    const after = loadApprovalRequest(STEERING_TEST_SURFACE, gateRequestId);
    expect(after?.applyResult?.result).toBe('failed');
    expect(after?.applyResult?.auditRef).toContain('steering authority lost');
  });

  it('(b) rejects an IL-04-unsatisfied finish with the gaps listed, never creating an approval or calling finish', async () => {
    const missionId = 'MSN-SO04-UNSATISFIED-B';
    createSession({ missionId, channel: 'C-b', threadTs: 'T-b' });
    setMissionSteeringReconciliationBuilderForTests(unsatisfiedReconciliationBuilder());
    const handler = buildMissionSteeringRouteHandler();

    const result = await handler.handle(
      buildContext('完了にして', { channel: 'C-b', threadTs: 'T-b' })
    );
    expect(validateSurfaceUxContract({ text: result.text }).valid).toBe(true);
    expect(result.text).toContain('完了にできません');
    expect(result.text).not.toMatch(/appr:[0-9a-f-]{36}:approve/i);
    expect(calls.some((c) => c.startsWith('finish:'))).toBe(false);

    const pending = withExecutionContext('mission_controller', () =>
      listApprovalRequests({ storageChannels: [STEERING_TEST_SURFACE], status: 'pending' })
    ).filter((record) => record.source?.missionId === missionId);
    expect(pending).toHaveLength(0);
  });

  it('(d) authority-error cases return formatSteeringRejection text (UX-valid) without executing the verb', async () => {
    const missionId = 'MSN-SO04-AUTH-D';
    const created = createSession({ missionId, channel: 'C-d', threadTs: 'T-d' });
    // Simulate a reclaimed/expired ownership lease without releasing the
    // journal record — same technique as surface-steering-authority.test.ts.
    releaseWorkItem({
      itemId: created.ownership_item_id!,
      leaseId: created.lease_id!,
      actorPeerId: created.owner_actor,
    });

    const handler = buildMissionSteeringRouteHandler();
    const context = buildContext('完了にして', { channel: 'C-d', threadTs: 'T-d' });
    // matches() only checks journal status (still 'active'), so it still matches.
    expect(handler.matches(context)).toBe(true);
    const result = await handler.handle(context);
    expect(result.text).toContain('リース');
    expect(validateSurfaceUxContract({ text: result.text }).valid).toBe(true);
    expect(calls.some((c) => c.startsWith('finish:'))).toBe(false);
  });

  it('(e) every steering response shape passes validateSurfaceUxContract', async () => {
    const missionId = 'MSN-SO04-UX-E';
    createSession({ missionId, channel: 'C-e', threadTs: 'T-e' });
    const handler = buildMissionSteeringRouteHandler();
    const at = (text: string) => buildContext(text, { channel: 'C-e', threadTs: 'T-e' });
    for (const text of ['ステータス', 'チェックポイント: メモ', '一時停止', '再開']) {
      const result = await handler.handle(at(text));
      expect(validateSurfaceUxContract({ text: result.text })).toMatchObject({ valid: true });
    }
    const gateResult = await handler.handle(at('承認'));
    expect(validateSurfaceUxContract({ text: gateResult.text })).toMatchObject({ valid: true });
    setMissionSteeringReconciliationBuilderForTests(unsatisfiedReconciliationBuilder());
    const finishRejected = await handler.handle(at('完了にして'));
    expect(validateSurfaceUxContract({ text: finishRejected.text })).toMatchObject({ valid: true });
  });
});

describe('no-bypass structural check (SO-04 Task 3)', () => {
  it('adapter.verify(/adapter.finish( appear ONLY inside executeApprovedMissionSteeringApproval', () => {
    const source = safeReadFile(`${pathResolver.rootDir()}/libs/core/surface-mission-steering.ts`, {
      encoding: 'utf8',
    }) as string;

    const fnStart = source.indexOf('export async function executeApprovedMissionSteeringApproval');
    expect(fnStart, 'executeApprovedMissionSteeringApproval not found in source').toBeGreaterThan(
      -1
    );
    // The function is the last top-level executable declaration before the
    // route-handler registration section's leading comment block.
    const fnEnd = source.indexOf('// Route handler registration seam', fnStart);
    expect(
      fnEnd,
      'could not locate the end boundary of executeApprovedMissionSteeringApproval'
    ).toBeGreaterThan(fnStart);

    for (const pattern of ['adapter.finish(', 'adapter.verify(']) {
      const allIndices: number[] = [];
      let fromIndex = 0;
      for (;;) {
        const idx = source.indexOf(pattern, fromIndex);
        if (idx < 0) break;
        allIndices.push(idx);
        fromIndex = idx + pattern.length;
      }
      expect(allIndices.length, `expected at least one ${pattern} call site`).toBeGreaterThan(0);
      for (const idx of allIndices) {
        expect(
          idx >= fnStart && idx < fnEnd,
          `${pattern} call site at index ${idx} falls outside executeApprovedMissionSteeringApproval ` +
            `(${fnStart}..${fnEnd}) — this would be a bypass of the approval contract`
        ).toBe(true);
      }
    }
  });

  it('the gate-approval and finish handlers never call the lifecycle adapter directly (behavioral proof)', async () => {
    const missionId = 'MSN-SO04-NOBYPASS-F';
    createSession({ missionId, channel: 'C-f', threadTs: 'T-f' });
    setMissionSteeringReconciliationBuilderForTests(satisfiedReconciliationBuilder());
    const handler = buildMissionSteeringRouteHandler();
    const at = (text: string) => buildContext(text, { channel: 'C-f', threadTs: 'T-f' });

    await handler.handle(at('承認'));
    await handler.handle(at('完了にして'));
    // Neither the gate-approval nor the finish REQUEST turn ever reaches the
    // underlying verb — only a later approved decision does (proven above
    // in the (a) full-flow test).
    expect(calls.some((c) => c.startsWith('verify:'))).toBe(false);
    expect(calls.some((c) => c.startsWith('finish:'))).toBe(false);
  });
});
