/**
 * SO-04: conversational mission steering + IL-04 completion verification.
 *
 * Adds a rule-based (no LLM) route handler to the surface conversation front
 * (`runSurfaceConversation` in surface-runtime-orchestrator.ts) that lets a
 * conversation thread holding an active `OrchestratorSession` (SO-02) steer
 * the mission it owns: status (read-only), checkpoint / pause / resume
 * (reversible, executed directly), and gate-approval / finish (irreversible,
 * approval-gated — see the no-bypass design note on
 * {@link executeApprovedMissionSteeringApproval} below).
 *
 * The session's own `mission_id` is always the steering target — this
 * module never parses a mission id out of free text. A thread with no
 * active session never matches (`matches()` returns false), so ordinary
 * conversation on a session-less thread is completely unaffected.
 *
 * Design notes on the two irreversible verbs:
 *
 *  - **finish** runs IL-04 (`reconcileCompletionStructurally` /
 *    `reconcileCompletion`, escalating to the LLM tightening pass only when
 *    the structural check is unsatisfied) BEFORE ever creating an approval
 *    request. An unsatisfied reconciliation is rejected immediately, with
 *    the gaps listed, and no approval request — and therefore no path to
 *    `finish` — is ever created. This mirrors the same construction
 *    `mission-lifecycle.ts`'s `finishMission` uses
 *    (`buildMissionCompletionReconciliationInput`, extracted there for this
 *    reuse) so the two finish paths (CLI-owned, surface-owned) never
 *    disagree about what "done" means.
 *  - **gate approval** maps onto the mission's own verify/gate step
 *    (`missionLifecycleService.verify`).
 *  - Neither verb's handler in this module ever calls
 *    `adapter.verify`/`adapter.finish` directly — the ONLY call sites for
 *    those two methods in this file are inside
 *    {@link executeApprovedMissionSteeringApproval}, which nothing in this
 *    module invokes. It is invoked exactly once, from
 *    `approval-store.ts`'s `decideApprovalRequest` (the single choke point
 *    every decision path — native action, `appr:<id>:decision` text,
 *    numbered-choice text, across every bridge — already funnels through),
 *    and only when a decision resolves to `approved`. See
 *    `surface-mission-steering.test.ts`'s no-bypass structural test.
 */
import { randomUUID } from 'node:crypto';
import { logger } from './core.js';
import { withExecutionContext } from './authority.js';
import type { GovernedArtifactRole } from './artifact-store.js';
import {
  createApprovalRequest,
  type ApprovalRequestRecord,
  type ApprovalSteeringAction,
} from './approval-store.js';
import { enqueueSurfaceOutboxMessage } from './surface-coordination-store.js';
import {
  getSessionForThread,
  renewOrchestratorSessionLease,
  type OrchestratorSessionRecord,
} from './orchestrator-session.js';
import {
  assertSurfaceSteeringAuthority,
  formatSteeringRejection,
  SurfaceSteeringAuthorityError,
} from './surface-steering-authority.js';
import {
  missionLifecycleService,
  type MissionLifecycleVerbOptions,
} from './mission-lifecycle-service.js';
import {
  buildMissionCompletionReconciliationInput,
  type MissionCompletionReconciliationContext,
} from './mission-lifecycle.js';
import { reconcileCompletion, reconcileCompletionStructurally } from './intent-reconciliation.js';
import { recordReasoningTierDeclaration } from './reasoning-tier-declaration.js';
import type { MissionStatusView } from './mission-read-model.js';
import type {
  SurfaceConversationInput,
  SurfaceConversationResult,
} from './channel-surface-types.js';
import type { SurfaceRuntimeRouteContext } from './surface-runtime-router.js';

// ---------------------------------------------------------------------------
// Verb classification — rule-based, no reasoning call.
// ---------------------------------------------------------------------------

export type SteeringVerb =
  | 'status'
  | 'checkpoint'
  | 'pause'
  | 'resume'
  | 'gate_approval'
  | 'finish';

export interface SteeringMatch {
  verb: SteeringVerb;
  note?: string;
}

interface SteeringRuleResult {
  matched: boolean;
  note?: string;
}

interface SteeringRule {
  verb: SteeringVerb;
  test: (text: string) => SteeringRuleResult;
}

function exactMatch(patterns: RegExp[]): (text: string) => SteeringRuleResult {
  return (text: string) => ({ matched: patterns.some((pattern) => pattern.test(text)) });
}

function stripTrailingPunctuation(text: string): string {
  return text.replace(/[。.!！?？\s]+$/u, '');
}

const STEERING_RULES: SteeringRule[] = [
  {
    verb: 'status',
    test: exactMatch([
      /^status$/i,
      /^ステータス$/,
      /^進捗$/,
      /^ステータス(教えて|確認して|は)$/,
      /^進捗(教えて|確認して|はどう|どう)$/,
    ]),
  },
  {
    verb: 'pause',
    test: exactMatch([/^pause$/i, /^一時停止$/, /^一時停止して$/]),
  },
  {
    verb: 'resume',
    test: exactMatch([/^resume$/i, /^再開$/, /^再開して$/]),
  },
  {
    verb: 'gate_approval',
    test: exactMatch([
      /^approve gate$/i,
      /^gate approval$/i,
      /^承認$/,
      /^承認する$/,
      /^承認します$/,
      /^ゲート承認$/,
      /^gate承認$/i,
    ]),
  },
  {
    verb: 'finish',
    test: exactMatch([/^finish mission$/i, /^finish$/i, /^完了にして$/, /^完了して$/]),
  },
  {
    verb: 'checkpoint',
    test: (text: string) => {
      const match = text.match(/^(?:checkpoint|チェックポイント)(?:$|[\s:：]+(.*)$)/i);
      if (!match) return { matched: false };
      const note = match[1]?.trim();
      return { matched: true, note: note || undefined };
    },
  },
];

/** Rule-based (no LLM) steering-intent classifier. Conservative by design — see module docstring. */
export function classifySteeringMessage(rawText: string): SteeringMatch | null {
  const text = stripTrailingPunctuation(String(rawText || '').trim());
  if (!text) return null;
  for (const rule of STEERING_RULES) {
    const result = rule.test(text);
    if (result.matched) return { verb: rule.verb, note: result.note };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Thread key derivation — session lookup, never free-text mission ids.
// ---------------------------------------------------------------------------

export interface SteeringThreadKey {
  surface: string;
  channel?: string;
  threadTs?: string;
}

export function deriveSteeringThreadKey(input: SurfaceConversationInput): SteeringThreadKey | null {
  const surface = input.surface || input.surfaceMetadata?.surface;
  if (!surface) return null;
  return {
    surface,
    channel: input.surfaceMetadata?.channel,
    threadTs: input.surfaceMetadata?.threadTs,
  };
}

function steeringMessageText(
  context: Pick<SurfaceRuntimeRouteContext, 'structuredQuery' | 'input'>
): string {
  return context.structuredQuery || context.input.query || '';
}

// ---------------------------------------------------------------------------
// Result / response builders — every branch carries a State + Next Action
// signal so it passes validateSurfaceUxContract (test-pinned).
// ---------------------------------------------------------------------------

function buildSteeringResult(text: string): SurfaceConversationResult {
  return {
    text,
    a2uiMessages: [],
    a2aMessages: [],
    delegationResults: [],
    approvalRequests: [],
    routingProposals: [],
    missionProposals: [],
    planningPackets: [],
  };
}

// ---------------------------------------------------------------------------
// Mission-lifecycle adapter — test seam. Defaults to the real SO-01 facade
// singleton (real gating/audit/session-release-on-finish); hermetic tests
// override with a facade built over a stub underlying system via
// `buildMissionLifecycleService` (mission-lifecycle-service.ts) so the
// facade's own gating/audit/release-hook logic still runs for real while no
// real mission I/O happens. `status` is intentionally a separate seam
// (`missionLifecycleService.status` is not parameterized by the underlying
// system — see mission-lifecycle-service.ts — so it cannot be stubbed via
// that route).
// ---------------------------------------------------------------------------

export interface MissionSteeringLifecycleAdapter {
  status: (missionId: string) => MissionStatusView | null;
  createCheckpoint: (
    taskId: string,
    note: string,
    missionId: string,
    options?: MissionLifecycleVerbOptions
  ) => Promise<unknown>;
  verify: (
    missionId: string,
    result: 'verified' | 'rejected',
    note: string,
    options?: MissionLifecycleVerbOptions
  ) => Promise<unknown>;
  finish: (
    missionId: string,
    seal: boolean,
    options?: MissionLifecycleVerbOptions
  ) => Promise<unknown>;
  pause: (
    missionId: string,
    note?: string,
    options?: MissionLifecycleVerbOptions
  ) => Promise<unknown>;
  resume: (missionId: string, options?: MissionLifecycleVerbOptions) => Promise<unknown>;
}

const defaultMissionSteeringLifecycleAdapter: MissionSteeringLifecycleAdapter = {
  status: (id) => missionLifecycleService.status(id),
  createCheckpoint: (taskId, note, missionId, options) =>
    missionLifecycleService.createCheckpoint(taskId, note, missionId, options),
  verify: (id, result, note, options) => missionLifecycleService.verify(id, result, note, options),
  finish: (id, seal, options) => missionLifecycleService.finish(id, seal, options),
  pause: (id, note, options) => missionLifecycleService.pause(id, note, options),
  resume: (id, options) => missionLifecycleService.resume(id, options),
};

let lifecycleAdapterOverride: MissionSteeringLifecycleAdapter | null = null;

/**
 * Test-only: override the adapter both the route handler and the
 * approval-execution path resolve through. Pass `null` to restore the real
 * default. Mirrors `resetOrchestratorSessionServiceForTests`
 * (orchestrator-session.ts) / `setMissionSteeringLifecycleAdapterForTests`
 * naming conventions used elsewhere in this codebase's test seams.
 */
export function setMissionSteeringLifecycleAdapterForTests(
  adapter: MissionSteeringLifecycleAdapter | null
): void {
  lifecycleAdapterOverride = adapter;
}

function resolveLifecycleAdapter(): MissionSteeringLifecycleAdapter {
  return lifecycleAdapterOverride ?? defaultMissionSteeringLifecycleAdapter;
}

export type MissionCompletionReconciliationBuilder = (
  missionId: string
) => MissionCompletionReconciliationContext | null;

let reconciliationBuilderOverride: MissionCompletionReconciliationBuilder | null = null;

/** Test-only: override the IL-04 reconciliation-input builder (real default reads mission state from disk). */
export function setMissionSteeringReconciliationBuilderForTests(
  builder: MissionCompletionReconciliationBuilder | null
): void {
  reconciliationBuilderOverride = builder;
}

function resolveReconciliationBuilder(): MissionCompletionReconciliationBuilder {
  return (
    reconciliationBuilderOverride ??
    ((missionId: string) => buildMissionCompletionReconciliationInput(missionId))
  );
}

// ---------------------------------------------------------------------------
// Direct-execution verbs: status (read-only), checkpoint / pause / resume
// (reversible).
// ---------------------------------------------------------------------------

const STEERING_CHECKPOINT_TASK_ID = 'surface-steering';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function handleStatusVerb(missionId: string): SurfaceConversationResult {
  const adapter = resolveLifecycleAdapter();
  try {
    const view = adapter.status(missionId);
    if (!view) {
      return buildSteeringResult(
        [
          `状態: ミッション ${missionId} の状態を取得できませんでした。`,
          '次のアクション: ミッションIDと権限を確認してください。',
        ].join('\n')
      );
    }
    const recentHistory = (view.recentHistory || [])
      .slice(-3)
      .map((entry) => `- ${entry.event}${entry.note ? `: ${entry.note}` : ''}`)
      .join('\n');
    return buildSteeringResult(
      [
        `状態: ミッション ${missionId} は現在 ${view.state.status} です。`,
        recentHistory ? `結果: 直近の履歴\n${recentHistory}` : '',
        `次のアクション: ${view.nextAction || '特にありません。'}`,
      ]
        .filter(Boolean)
        .join('\n')
    );
  } catch (error) {
    return buildSteeringResult(
      [
        `状態: ミッション ${missionId} の状態取得に失敗しました(${errorMessage(error)})。`,
        '次のアクション: しばらくしてから再度お試しください。',
      ].join('\n')
    );
  }
}

async function handleCheckpointVerb(
  missionId: string,
  note: string | undefined,
  surfaceTag: string
): Promise<SurfaceConversationResult> {
  const adapter = resolveLifecycleAdapter();
  const effectiveNote =
    note && note.trim() ? note.trim() : `${surfaceTag} 経由の操縦チェックポイント`;
  try {
    await withExecutionContext('mission_controller', () =>
      adapter.createCheckpoint(STEERING_CHECKPOINT_TASK_ID, effectiveNote, missionId, {
        surface: surfaceTag,
      })
    );
    return buildSteeringResult(
      [
        `状態: ミッション ${missionId} にチェックポイントを記録しました。`,
        `結果: ${effectiveNote}`,
        '次のアクション: 作業を継続してください。',
      ].join('\n')
    );
  } catch (error) {
    return buildSteeringResult(
      [
        `状態: チェックポイントの記録に失敗しました(${errorMessage(error)})。`,
        '次のアクション: ミッションの状態を確認してから再試行してください。',
      ].join('\n')
    );
  }
}

async function handlePauseVerb(
  missionId: string,
  surfaceTag: string
): Promise<SurfaceConversationResult> {
  const adapter = resolveLifecycleAdapter();
  try {
    await withExecutionContext('mission_controller', () =>
      adapter.pause(missionId, `${surfaceTag} 経由の操縦一時停止`, { surface: surfaceTag })
    );
    return buildSteeringResult(
      [
        `状態: ミッション ${missionId} を一時停止しました。`,
        '次のアクション: 再開する場合は「再開」と送信してください。',
      ].join('\n')
    );
  } catch (error) {
    return buildSteeringResult(
      [
        `状態: 一時停止に失敗しました(${errorMessage(error)})。`,
        '次のアクション: ミッションの状態を確認してください。',
      ].join('\n')
    );
  }
}

async function handleResumeVerb(
  missionId: string,
  surfaceTag: string
): Promise<SurfaceConversationResult> {
  const adapter = resolveLifecycleAdapter();
  try {
    await withExecutionContext('mission_controller', () =>
      adapter.resume(missionId, { surface: surfaceTag })
    );
    return buildSteeringResult(
      [
        `状態: ミッション ${missionId} を再開しました。`,
        '次のアクション: 進捗は「ステータス」で確認できます。',
      ].join('\n')
    );
  } catch (error) {
    return buildSteeringResult(
      [
        `状態: 再開に失敗しました(${errorMessage(error)})。`,
        '次のアクション: ミッションの状態を確認してください。',
      ].join('\n')
    );
  }
}

// ---------------------------------------------------------------------------
// Approval-gated verbs: gate approval (verify) / finish. NEVER execute
// directly — only ever create an approval request. See module docstring's
// no-bypass design note.
// ---------------------------------------------------------------------------

function approvalRoleForSurface(surface: string): GovernedArtifactRole {
  return surface === 'slack' ? 'slack_bridge' : 'surface_runtime';
}

function buildApprovalPendingText(params: {
  verbLabel: string;
  missionId: string;
  requestId: string;
  note?: string;
}): string {
  return [
    `状態: ミッション ${params.missionId} の${params.verbLabel}には承認が必要です。`,
    params.note ? `メモ: ${params.note}` : '',
    '1: 承認する',
    '2: 却下する',
    `返信: appr:${params.requestId}:approve または appr:${params.requestId}:reject`,
    `次のアクション: 上記のいずれかで承認要求(${params.requestId})に回答してください。`,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildSteeringApprovalRequest(params: {
  missionId: string;
  key: SteeringThreadKey;
  verb: ApprovalSteeringAction['verb'];
  note: string | undefined;
  title: string;
  summary: string;
  severity: 'low' | 'medium' | 'high';
}): ApprovalRequestRecord {
  const channel = params.key.channel || 'default';
  const threadTs = params.key.threadTs || 'default';
  const correlationId = randomUUID();
  const steering: ApprovalSteeringAction = {
    kind: 'mission_lifecycle_verb',
    verb: params.verb,
    missionId: params.missionId,
    note: params.note,
    surface: params.key.surface,
    channel,
    threadTs,
    correlationId,
  };
  return createApprovalRequest(approvalRoleForSurface(params.key.surface), {
    channel,
    storageChannel: params.key.surface,
    threadTs,
    correlationId,
    requestedBy: `${params.key.surface}_surface_steering`,
    draft: {
      title: params.title,
      summary: params.summary,
      severity: params.severity,
    },
    sourceText: params.note,
    source: { missionId: params.missionId },
    steering,
    accountability: { finalDecision: 'human_only' },
  });
}

async function handleGateApprovalVerb(params: {
  missionId: string;
  key: SteeringThreadKey;
  note?: string;
}): Promise<SurfaceConversationResult> {
  const record = buildSteeringApprovalRequest({
    missionId: params.missionId,
    key: params.key,
    verb: 'verify',
    note: params.note,
    title: `ミッション ${params.missionId} のゲート承認`,
    summary: params.note
      ? `ゲート承認要求: ${params.note}`
      : `ミッション ${params.missionId} のゲート承認要求です。`,
    severity: 'medium',
  });
  return buildSteeringResult(
    buildApprovalPendingText({
      verbLabel: 'ゲート承認',
      missionId: params.missionId,
      requestId: record.id,
      note: params.note,
    })
  );
}

/**
 * SO-04 Task 2 (IL-04): builds the same `reconciliationInput`
 * `mission-lifecycle.ts`'s `finishMission` builds (via
 * `buildMissionCompletionReconciliationInput`, or the injected test
 * builder), runs the structural check first, escalates to the LLM
 * tightening pass (declared `deep`) only when unsatisfied — mirroring
 * `finishMission` exactly.
 */
async function reconcileFinishCompletion(
  missionId: string
): Promise<{ satisfied: boolean; gaps: string[]; missingContext?: true }> {
  const built = resolveReconciliationBuilder()(missionId);
  if (!built) return { satisfied: false, gaps: [], missingContext: true };
  const structural = reconcileCompletionStructurally(built.reconciliationInput);
  if (structural.satisfied) return { satisfied: true, gaps: [] };
  recordReasoningTierDeclaration({
    callSite: 'surface_mission_steering_finish_reconciliation',
    declaredTier: 'deep',
  });
  const tightened = await reconcileCompletion(built.reconciliationInput, { model_tier: 'deep' });
  return { satisfied: tightened.satisfied, gaps: tightened.gaps };
}

async function handleFinishRequestVerb(params: {
  missionId: string;
  key: SteeringThreadKey;
  note?: string;
}): Promise<SurfaceConversationResult> {
  const reconciliation = await reconcileFinishCompletion(params.missionId);
  if (reconciliation.missingContext) {
    return buildSteeringResult(
      [
        `状態: ミッション ${params.missionId} が見つからないため完了にできません。`,
        '次のアクション: ミッションIDを確認してください。',
      ].join('\n')
    );
  }
  if (!reconciliation.satisfied) {
    const gaps =
      reconciliation.gaps.length > 0
        ? reconciliation.gaps.map((gap) => `- ${gap}`).join('\n')
        : '- (詳細不明)';
    return buildSteeringResult(
      [
        `状態: ミッション ${params.missionId} は完了条件(IL-04)を満たしていないため完了にできません。`,
        `結果: 未充足のギャップ\n${gaps}`,
        '次のアクション: 上記のギャップを解消してから、再度「完了にして」と送信してください。',
      ].join('\n')
    );
  }

  const record = buildSteeringApprovalRequest({
    missionId: params.missionId,
    key: params.key,
    verb: 'finish',
    note: params.note,
    title: `ミッション ${params.missionId} の完了`,
    summary: `ミッション ${params.missionId} を完了(finish)します。完了条件(IL-04)は満たされています。`,
    severity: 'high',
  });
  return buildSteeringResult(
    buildApprovalPendingText({
      verbLabel: '完了(finish)',
      missionId: params.missionId,
      requestId: record.id,
      note: params.note,
    })
  );
}

// ---------------------------------------------------------------------------
// Approval-execution path — invoked ONLY from approval-store.ts's
// `decideApprovalRequest` (via a dynamic import, to avoid a static import
// cycle) when a decision on a steering-originated request resolves to
// `approved`. This is the ONLY place in this module that calls
// `adapter.verify` / `adapter.finish` — see module docstring.
// ---------------------------------------------------------------------------

export async function executeApprovedMissionSteeringApproval(
  record: ApprovalRequestRecord
): Promise<string> {
  const steering = record.steering;
  if (!steering) {
    throw new Error(
      `[surface-mission-steering] approval ${record.id} has no steering action to execute`
    );
  }
  // Re-assert steering authority AT EXECUTION TIME, not just when the
  // approval request was created: a human decision can arrive minutes or
  // hours later, and by then the thread may have lost ownership (handoff to
  // the CLI released the session, the ownership lease expired or was
  // reclaimed). The SO-03 session+claim double condition must hold at the
  // moment the verb runs — otherwise a stale thread's approval could steer a
  // mission it no longer owns. On loss, notify the thread and fail the
  // apply (recorded as apply_failed by approval-store).
  try {
    assertSurfaceSteeringAuthority({
      surface: steering.surface,
      channel: steering.channel,
      threadTs: steering.threadTs,
      missionId: steering.missionId,
    });
  } catch (error) {
    if (error instanceof SurfaceSteeringAuthorityError) {
      try {
        enqueueSurfaceOutboxMessage({
          surface: steering.surface,
          correlationId: steering.correlationId,
          channel: steering.channel,
          threadTs: steering.threadTs,
          text: [
            `状態: 承認された操作(${steering.verb})は実行されませんでした — このスレッドはミッション ${steering.missionId} の所有権を失っています(${error.caseId})。`,
            formatSteeringRejection(error),
          ].join('\n'),
          source: 'system',
        });
      } catch (notifyError) {
        logger.warn(
          `[surface-mission-steering] authority-loss notification failed: ${errorMessage(notifyError)}`
        );
      }
      throw new Error(
        `[surface-mission-steering] steering authority lost before execution of approval ${record.id}: ${error.caseId}`
      );
    }
    throw error;
  }
  const adapter = resolveLifecycleAdapter();
  const options: MissionLifecycleVerbOptions = { surface: steering.surface };
  let outcomeText: string;
  if (steering.verb === 'verify') {
    await withExecutionContext('mission_controller', () =>
      adapter.verify(
        steering.missionId,
        'verified',
        steering.note || 'surface steering gate approval',
        options
      )
    );
    outcomeText = `ミッション ${steering.missionId} のゲートを承認しました。`;
  } else if (steering.verb === 'finish') {
    await withExecutionContext('mission_controller', () =>
      adapter.finish(steering.missionId, false, options)
    );
    outcomeText = `ミッション ${steering.missionId} を完了しました。`;
  } else {
    const exhaustiveCheck: never = steering.verb;
    throw new Error(
      `[surface-mission-steering] unsupported steering verb: ${String(exhaustiveCheck)}`
    );
  }

  try {
    enqueueSurfaceOutboxMessage({
      surface: steering.surface,
      correlationId: steering.correlationId,
      channel: steering.channel,
      threadTs: steering.threadTs,
      text: [
        `状態: ${outcomeText}`,
        '次のアクション: 必要であれば「ステータス」で確認してください。',
      ].join('\n'),
      source: 'system',
    });
  } catch (error) {
    logger.warn(`[surface-mission-steering] outbox notification failed: ${errorMessage(error)}`);
  }

  return outcomeText;
}

// ---------------------------------------------------------------------------
// Route handler registration seam (SURFACE_RUNTIME_ROUTE_HANDLERS in
// surface-runtime-orchestrator.ts). Defined structurally (not importing the
// private `SurfaceRuntimeRouteHandler` interface from that file) so this
// module has no dependency on it beyond the shared, exported
// `SurfaceRuntimeRouteContext` / `SurfaceConversationResult` types.
// ---------------------------------------------------------------------------

export interface MissionSteeringRouteHandler {
  matches: (context: SurfaceRuntimeRouteContext) => boolean;
  handle: (context: SurfaceRuntimeRouteContext) => Promise<SurfaceConversationResult>;
}

function missionSteeringRejectionResult(text: string): SurfaceConversationResult {
  return buildSteeringResult(text);
}

async function handleMissionSteeringTurn(
  context: SurfaceRuntimeRouteContext
): Promise<SurfaceConversationResult> {
  const key = deriveSteeringThreadKey(context.input);
  const match = key ? classifySteeringMessage(steeringMessageText(context)) : null;
  if (!key || !match) {
    // Defensive only — matches() already guarantees both are non-null.
    return missionSteeringRejectionResult(
      [
        '状態: 操縦意図を解釈できませんでした。',
        '次のアクション: 「ステータス」「チェックポイント: <メモ>」「一時停止」「再開」「承認」「完了にして」のいずれかを送信してください。',
      ].join('\n')
    );
  }

  const session = getSessionForThread(key.surface, key.channel, key.threadTs);
  if (!session) {
    return missionSteeringRejectionResult(
      [
        '状態: このスレッドのオーケストレータセッションが見つかりません。',
        '次のアクション: セッションを再作成してから操縦してください。',
      ].join('\n')
    );
  }

  let authorized: OrchestratorSessionRecord;
  try {
    authorized = assertSurfaceSteeringAuthority({
      surface: key.surface,
      channel: key.channel,
      threadTs: key.threadTs,
      missionId: session.mission_id,
    });
  } catch (error) {
    if (error instanceof SurfaceSteeringAuthorityError) {
      return missionSteeringRejectionResult(formatSteeringRejection(error));
    }
    throw error;
  }

  try {
    withExecutionContext('mission_controller', () =>
      renewOrchestratorSessionLease(authorized.session_id)
    );
  } catch (error) {
    logger.warn(
      `[surface-mission-steering] best-effort lease renewal failed for session ${authorized.session_id}: ${errorMessage(error)}`
    );
  }

  const missionId = authorized.mission_id;
  const surfaceTag = key.surface;

  switch (match.verb) {
    case 'status':
      return handleStatusVerb(missionId);
    case 'checkpoint':
      return handleCheckpointVerb(missionId, match.note, surfaceTag);
    case 'pause':
      return handlePauseVerb(missionId, surfaceTag);
    case 'resume':
      return handleResumeVerb(missionId, surfaceTag);
    case 'gate_approval':
      return handleGateApprovalVerb({ missionId, key, note: match.note });
    case 'finish':
      return handleFinishRequestVerb({ missionId, key, note: match.note });
    default: {
      const exhaustiveCheck: never = match.verb;
      throw new Error(
        `[surface-mission-steering] unhandled steering verb: ${String(exhaustiveCheck)}`
      );
    }
  }
}

export function buildMissionSteeringRouteHandler(): MissionSteeringRouteHandler {
  return {
    matches(context: SurfaceRuntimeRouteContext): boolean {
      const key = deriveSteeringThreadKey(context.input);
      if (!key) return false;
      const session = getSessionForThread(key.surface, key.channel, key.threadTs);
      if (!session) return false;
      return classifySteeringMessage(steeringMessageText(context)) !== null;
    },
    handle: handleMissionSteeringTurn,
  };
}

/** Default handler instance registered into SURFACE_RUNTIME_ROUTE_HANDLERS. */
export const missionSteeringRouteHandler: MissionSteeringRouteHandler =
  buildMissionSteeringRouteHandler();
