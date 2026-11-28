/**
 * Real-dot semantic_judgment improvement loop & graduated relaxation.
 *
 * Connects:
 * 1. Live proposal observation (`shadow` / `advisory`) via `LiveJudgmentInvokePort`
 *    and synchronous `createDotSemanticSharedBudgetPort`.
 * 2. Reconciliation against human `dot-feedback.jsonl` and `outcomes.jsonl`.
 * 3. Automatic distill candidate emission (`execution-feedback.ts`) on disagreements.
 * 4. Evidence-backed `approve -> notify` relaxation in `advisory` mode via
 *    `DOT_SEMANTIC_APPROVE_TO_NOTIFY_EXCEPTION`, with immediate auto-demotion on
 *    rejection, regression, or unavailable judgment.
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir } from '../secure-io.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { appendJsonLine, writeJsonLines } from '../foundation/json.js';
import { readJsonLinesBackward, streamJsonLines } from '../storage/jsonl-read.js';
import { VETO_WINDOW_DECIDER } from '../governance/approval-veto-window.js';
import type { AutonomousOpsGateResult } from '../governance/autonomous-ops-gate.js';
import type { ExecutionFeedbackOutcome } from '../knowledge/execution-feedback.js';
import type { MemoryScopeEnvelope } from '../knowledge/memory-scope.js';
import { judgmentCanonicalHash } from '../organization/judgment-precedents.js';
import type { SemanticJudgmentUsage } from '../organization/semantic-judgment.js';
import {
  evaluateLiveDotProposalJudgment,
  resolveLiveJudgmentInvokePort,
  type DotProposalJudgmentVerdict,
  type LiveJudgmentInvokePort,
} from '../organization/semantic-judgment-live-provider.js';
import type { DotCharter } from './dot-charter.js';
import {
  DOT_SEMANTIC_APPROVE_TO_NOTIFY_EXCEPTION,
  type DotDecisionRelaxer,
  type DotDigestSection,
  type DotExtCtx,
  type DotStatusSection,
} from './dot-extensions.js';
import {
  dotFeedbackPromptLines,
  dotSignalStatusLines,
  readDotFeedback,
  type DotFeedbackEntry,
} from './dot-feedback.js';
import type { DotProposal } from './dot-proposals.js';
import {
  createDotSemanticSharedBudgetPort,
  type DotSemanticLiveBudgetPort,
} from './dot-semantic-budget.js';
import type { DotSemanticBudgetOwner, DotSemanticKnownUsage } from './dot-semantic-judgment.js';
import { DOT_OUTCOMES_FILE, dotStatePath, type DotOutcomeRow } from './dot-state-paths.js';

const logger = createLogger('dot-semantic-loop');

export const DOT_SEMANTIC_JUDGMENT_LEDGER_FILE = 'semantic-judgment-ledger.jsonl';
export const DOT_SEMANTIC_RECONCILIATION_FILE = 'semantic-judgment-reconciled.jsonl';
export const DOT_SEMANTIC_LEDGER_MAX_ROWS = 500;
const COMPACT_HEADROOM = 100;
const MAX_PROPOSALS_PER_WAKE = 10;
const DEFAULT_MAX_OUTPUT_TOKENS = 512;
const DEFAULT_RESERVE_TOKENS = 2048;
const EVALUATION_DEADLINE_MS = 15_000;
const HARD_ESCALATIONS = new Set(['never_auto', 'high_risk_path', 'axis_max', 'budget']);

export interface SemanticRelaxationPolicy {
  min_decisions: number;
  min_agreement: number;
  min_outcome_success: number;
  max_false_apply: number;
}

export const DEFAULT_SEMANTIC_RELAXATION_POLICY: SemanticRelaxationPolicy = {
  min_decisions: 5,
  min_agreement: 0.9,
  min_outcome_success: 0.8,
  max_false_apply: 0,
};

export interface DotSemanticJudgmentRecord {
  dot_id: string;
  action_id: string;
  title: string;
  proposal_hash: string;
  mode: 'shadow' | 'advisory';
  status: 'evaluated' | 'unavailable';
  verdict?: DotProposalJudgmentVerdict;
  reason?: string;
  detail?: string;
  provider?: string;
  model?: string;
  route?: 'primary' | 'fallback';
  route_reason?: string;
  confidence?: number;
  evaluated_at?: string;
  expires_at?: string;
  budget_status: 'not_reserved' | 'settled' | 'held_unknown' | 'unavailable';
  usage?: SemanticJudgmentUsage;
  recorded_at: string;
}

export interface DotSemanticReconciliationRow {
  dot_id: string;
  action_ref: string;
  action_id: string;
  title: string;
  judgment_disposition: DotProposalJudgmentVerdict['disposition'];
  human_outcome: 'approved' | 'rejected';
  execution_outcome?: DotOutcomeRow['verdict'];
  agree: boolean;
  false_apply: boolean;
  mismatch_kind?: 'false_apply' | 'over_cautious';
  recorded_at: string;
}

export interface DotSemanticLoopDeps {
  rootDir?: string;
  now?: () => Date;
  invoke?: LiveJudgmentInvokePort | null;
  budget?: DotSemanticLiveBudgetPort;
  accountingId?: string;
  policy?: Partial<SemanticRelaxationPolicy>;
  recordDistillFeedback?: (input: {
    dot_id: string;
    action_id: string;
    action_ref: string;
    outcome: ExecutionFeedbackOutcome;
    comment: string;
    correction: string;
    scope: DotCharter['scope'];
  }) => void | Promise<void>;
}

export interface DotSemanticJudgmentMetrics {
  mode: 'off' | 'shadow' | 'advisory';
  judgments: number;
  evaluated: number;
  unavailable: number;
  reconciled: number;
  agreed: number;
  agreement_rate: number;
  false_apply_count: number;
  recent_rejection_streak: number;
  outcomes_judged: number;
  outcome_success_rate: number;
  recent_regressed_count: number;
  relaxation_eligible: boolean;
  relaxation_blocked_reason?: string;
  last_provider?: string;
  last_model?: string;
  primary_route_count: number;
  fallback_route_count: number;
  primary_route_rate: number | null;
  next_action: string;
}

function ledgerAbs(c: DotCharter, file: string, rootDir?: string): string {
  return path.join(rootDir ?? pathResolver.rootDir(), dotStatePath(c, file));
}

function appendScopedRow(c: DotCharter, file: string, row: unknown, rootDir?: string): void {
  const target = ledgerAbs(c, file, rootDir);
  const lockKey =
    'dot-semantic-loop:' + createHash('sha256').update(path.resolve(target)).digest('hex');
  withLockSync(lockKey, () => {
    safeMkdir(path.dirname(target), { recursive: true });
    appendJsonLine(target, row);
    const keepReversed: unknown[] = [];
    let exceeded = false;
    for (const entry of readJsonLinesBackward<unknown>(target, { onMalformed: 'skip' })) {
      keepReversed.push(entry);
      if (keepReversed.length > DOT_SEMANTIC_LEDGER_MAX_ROWS + COMPACT_HEADROOM) {
        exceeded = true;
        break;
      }
    }
    if (exceeded) {
      writeJsonLines(target, keepReversed.slice(0, DOT_SEMANTIC_LEDGER_MAX_ROWS).reverse());
    }
  });
}

export function dotProposalFingerprint(
  proposal: Pick<
    DotProposal,
    'action_id' | 'title' | 'objective' | 'execution_shape' | 'pipeline_ref'
  >
): string {
  return judgmentCanonicalHash({
    action_id: proposal.action_id,
    title: proposal.title,
    objective: proposal.objective,
    execution_shape: proposal.execution_shape,
    ...(proposal.pipeline_ref ? { pipeline_ref: proposal.pipeline_ref } : {}),
  });
}

export function readDotSemanticJudgmentLedger(
  c: DotCharter,
  deps: Pick<DotSemanticLoopDeps, 'rootDir'> = {}
): DotSemanticJudgmentRecord[] {
  return [
    ...streamJsonLines<DotSemanticJudgmentRecord>(
      ledgerAbs(c, DOT_SEMANTIC_JUDGMENT_LEDGER_FILE, deps.rootDir),
      { onMalformed: 'skip' }
    ),
  ].filter((row) => row?.dot_id === c.dot_id && typeof row.action_id === 'string');
}

export function readDotSemanticReconciliations(
  c: DotCharter,
  deps: Pick<DotSemanticLoopDeps, 'rootDir'> = {}
): DotSemanticReconciliationRow[] {
  return [
    ...streamJsonLines<DotSemanticReconciliationRow>(
      ledgerAbs(c, DOT_SEMANTIC_RECONCILIATION_FILE, deps.rootDir),
      { onMalformed: 'skip' }
    ),
  ].filter((row) => row?.dot_id === c.dot_id && typeof row.action_ref === 'string');
}

function knownUsageFrom(usage: SemanticJudgmentUsage): DotSemanticKnownUsage | null {
  if (
    (usage.usage_status === 'reported' || usage.usage_status === 'not_invoked') &&
    typeof usage.input_tokens === 'number' &&
    Number.isInteger(usage.input_tokens) &&
    usage.input_tokens >= 0 &&
    typeof usage.output_tokens === 'number' &&
    Number.isInteger(usage.output_tokens) &&
    usage.output_tokens >= 0
  ) {
    return {
      ...usage,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      usage_status: usage.usage_status,
    };
  }
  return null;
}

function recentApprovedPrecedents(
  c: DotCharter,
  deps: Pick<DotSemanticLoopDeps, 'rootDir' | 'now'>
): Array<{ ref: string; summary: string }> {
  return readDotFeedback(c.dot_id, deps)
    .filter((row) => row.outcome === 'approved')
    .slice(-10)
    .reverse()
    .map((row) => ({
      ref: row.action_ref.slice(0, 128),
      summary: `${row.action_id}: ${row.title}`.slice(0, 1000),
    }));
}

/**
 * Run live semantic_judgment observation on a delivered wake's proposals.
 * Runs in `shadow` and `advisory` modes; `off` does nothing.
 */
export async function observeLiveDotProposals(
  charter: DotCharter,
  proposals: readonly DotProposal[],
  deps: DotSemanticLoopDeps = {}
): Promise<DotSemanticJudgmentRecord[]> {
  const mode = charter.runtime.semantic_judgment?.mode ?? 'off';
  if (mode === 'off' || proposals.length === 0) return [];

  const nowFn = deps.now ?? (() => new Date());
  const ownsPort = deps.invoke === undefined;
  const invoke = ownsPort ? resolveLiveJudgmentInvokePort() : (deps.invoke ?? null);
  if (!invoke) {
    const diagnostic: DotSemanticJudgmentRecord = {
      dot_id: charter.dot_id,
      action_id: proposals[0].action_id,
      title: proposals[0].title.slice(0, 200),
      proposal_hash: dotProposalFingerprint(proposals[0]),
      mode,
      status: 'unavailable',
      reason: 'provider_error',
      detail: 'No live semantic_judgment provider is configured',
      budget_status: 'not_reserved',
      recorded_at: nowFn().toISOString(),
    };
    appendScopedRow(charter, DOT_SEMANTIC_JUDGMENT_LEDGER_FILE, diagnostic, deps.rootDir);
    return [diagnostic];
  }

  const budget =
    deps.budget ??
    createDotSemanticSharedBudgetPort({
      rootDir: deps.rootDir,
      now: nowFn,
      charter,
    });
  const feedbackLines = dotFeedbackPromptLines(charter.dot_id, deps, 10);
  const signalLines = dotSignalStatusLines(charter, deps).slice(0, 10);
  const precedents = recentApprovedPrecedents(charter, deps);
  const scopeHash = judgmentCanonicalHash(charter.scope);
  const records: DotSemanticJudgmentRecord[] = [];

  try {
    await invoke.warmup?.();
    const wakeStartMs = nowFn().getTime();
    const wakeBudgetMs = charter.goal.budget?.wall_clock_ms_per_wake;
    const wakeDeadlineMs =
      typeof wakeBudgetMs === 'number' && Number.isFinite(wakeBudgetMs) && wakeBudgetMs > 0
        ? wakeStartMs + Math.floor(wakeBudgetMs)
        : wakeStartMs + EVALUATION_DEADLINE_MS * MAX_PROPOSALS_PER_WAKE;

    for (const [index, proposal] of proposals.slice(0, MAX_PROPOSALS_PER_WAKE).entries()) {
      const now = nowFn();
      const nowMs = now.getTime();
      const day = now.toISOString().slice(0, 10);
      const proposalHash = dotProposalFingerprint(proposal);
      const perProposalDeadlineMs = Math.min(nowMs + EVALUATION_DEADLINE_MS, wakeDeadlineMs);
      if (perProposalDeadlineMs <= nowMs) {
        const expired: DotSemanticJudgmentRecord = {
          dot_id: charter.dot_id,
          action_id: proposal.action_id,
          title: proposal.title.slice(0, 200),
          proposal_hash: proposalHash,
          mode,
          status: 'unavailable',
          reason: 'deadline_exceeded',
          detail: 'Wake semantic judgment wall-clock budget exhausted',
          provider: invoke.provider,
          model: invoke.model,
          budget_status: 'not_reserved',
          recorded_at: now.toISOString(),
        };
        appendScopedRow(charter, DOT_SEMANTIC_JUDGMENT_LEDGER_FILE, expired, deps.rootDir);
        records.push(expired);
        continue;
      }

      const owner: DotSemanticBudgetOwner = {
        dot_id: charter.dot_id,
        accounting_id: deps.accountingId ?? `dot-semantic:${charter.dot_id}:${day}`,
        scope_hash: scopeHash,
        day,
      };
      const reservationKey = judgmentCanonicalHash({
        owner,
        proposalHash,
        index,
        at: nowMs,
      });

      const reserved = budget.reserve({
        parent: owner,
        reservation_key: reservationKey,
        max_tokens: DEFAULT_RESERVE_TOKENS,
      });
      if (reserved.status !== 'reserved') {
        const record: DotSemanticJudgmentRecord = {
          dot_id: charter.dot_id,
          action_id: proposal.action_id,
          title: proposal.title.slice(0, 200),
          proposal_hash: proposalHash,
          mode,
          status: 'unavailable',
          reason: 'budget_exhausted',
          detail: 'Shared semantic judgment daily budget unavailable',
          budget_status: 'unavailable',
          recorded_at: now.toISOString(),
        };
        appendScopedRow(charter, DOT_SEMANTIC_JUDGMENT_LEDGER_FILE, record, deps.rootDir);
        records.push(record);
        continue;
      }

      const result = await evaluateLiveDotProposalJudgment(
        {
          input: {
            kind: 'dot_proposal_v1',
            dot_id: charter.dot_id,
            goal_statement: charter.goal.statement.slice(0, 2000),
            proposal: {
              action_id: proposal.action_id,
              title: proposal.title.slice(0, 500),
              objective: proposal.objective.slice(0, 2000),
              execution_shape: proposal.execution_shape,
              ...(proposal.pipeline_ref
                ? { pipeline_ref: proposal.pipeline_ref.slice(0, 500) }
                : {}),
              ...(proposal.changed_paths?.length
                ? { changed_paths: proposal.changed_paths.slice(0, 20).map((p) => p.slice(0, 500)) }
                : {}),
            },
            recent_feedback: feedbackLines.map((line) => line.slice(0, 500)),
            signals: signalLines.map((line) => line.slice(0, 500)),
            precedents,
          },
          parentDeadlineMs: perProposalDeadlineMs,
          parentTokenAllowance: reserved.token_allowance,
          maxOutputTokens: Math.min(DEFAULT_MAX_OUTPUT_TOKENS, reserved.token_allowance),
        },
        { port: invoke, now: () => nowFn().getTime() }
      );

      const known = knownUsageFrom(result.usage);
      let budgetStatus: DotSemanticJudgmentRecord['budget_status'] = 'held_unknown';
      try {
        if (known) {
          budget.settle(reserved.handle, owner, known);
          budgetStatus = 'settled';
        } else {
          budget.holdUnknown(reserved.handle, owner);
          budgetStatus = 'held_unknown';
        }
      } catch (error) {
        logger.warn(
          `[dot-semantic-loop] budget settlement failed for ${charter.dot_id}: ${error instanceof Error ? error.message : String(error)}`
        );
        budgetStatus = 'unavailable';
      }

      const recordedAt = nowFn().toISOString();
      const metaFields = {
        ...(result.meta?.route ? { route: result.meta.route } : {}),
        ...(result.meta?.route_reason ? { route_reason: result.meta.route_reason } : {}),
        ...(typeof result.meta?.confidence === 'number'
          ? { confidence: result.meta.confidence }
          : {}),
      };
      const record: DotSemanticJudgmentRecord =
        result.assessment.status === 'evaluated'
          ? {
              dot_id: charter.dot_id,
              action_id: proposal.action_id,
              title: proposal.title.slice(0, 200),
              proposal_hash: proposalHash,
              mode,
              status: 'evaluated',
              verdict: result.assessment.verdict,
              provider: result.assessment.provider,
              model: result.assessment.model,
              ...metaFields,
              evaluated_at: result.assessment.evaluated_at,
              expires_at: result.assessment.expires_at,
              budget_status: budgetStatus,
              usage: result.usage,
              recorded_at: recordedAt,
            }
          : {
              dot_id: charter.dot_id,
              action_id: proposal.action_id,
              title: proposal.title.slice(0, 200),
              proposal_hash: proposalHash,
              mode,
              status: 'unavailable',
              reason: result.assessment.reason,
              detail: result.assessment.detail,
              provider: invoke.provider,
              model: invoke.model,
              ...metaFields,
              budget_status: budgetStatus,
              usage: result.usage,
              recorded_at: recordedAt,
            };

      appendScopedRow(charter, DOT_SEMANTIC_JUDGMENT_LEDGER_FILE, record, deps.rootDir);
      records.push(record);
    }
  } finally {
    if (ownsPort) invoke.dispose?.();
  }

  return records;
}

function isSettledHumanDecision(row: DotFeedbackEntry): row is DotFeedbackEntry & {
  outcome: 'approved' | 'rejected';
} {
  if (row.outcome === 'rejected') return true;
  return (
    row.outcome === 'approved' &&
    row.decided_by_type === 'human' &&
    row.decided_by !== VETO_WINDOW_DECIDER
  );
}

function findMatchingJudgment(
  judgments: readonly DotSemanticJudgmentRecord[],
  feedback: DotFeedbackEntry
): DotSemanticJudgmentRecord | undefined {
  const feedbackAt = Date.parse(feedback.recorded_at);
  const candidates = judgments.filter(
    (row) =>
      row.status === 'evaluated' &&
      row.verdict &&
      row.action_id === feedback.action_id &&
      (!Number.isFinite(feedbackAt) || Date.parse(row.recorded_at) <= feedbackAt)
  );
  if (candidates.length === 0) return undefined;
  const sameTitle = candidates.filter((row) => row.title === feedback.title.slice(0, 200));
  const pool = sameTitle.length > 0 ? sameTitle : candidates;
  return pool[pool.length - 1];
}

async function emitDistillFeedbackDefault(input: {
  dot_id: string;
  action_id: string;
  action_ref: string;
  outcome: ExecutionFeedbackOutcome;
  comment: string;
  correction: string;
  scope: DotCharter['scope'];
}): Promise<void> {
  const { recordExecutionFeedback, materializeExecutionFeedbackCandidate } =
    await import('../knowledge/execution-feedback.js');
  const scope: MemoryScopeEnvelope = {
    tier: input.scope.tier,
    ...(input.scope.tenant_slug ? { tenant_slug: input.scope.tenant_slug } : {}),
    ...(input.scope.organization_id ? { organization_id: input.scope.organization_id } : {}),
    ...(input.scope.project_id ? { project_id: input.scope.project_id } : {}),
  };
  const feedback = recordExecutionFeedback({
    scenario_id: `dot-semantic-judgment:${input.dot_id}`,
    intent_id: input.action_id,
    correlation_id: input.action_ref,
    surface: 'dot',
    outcome: input.outcome,
    comment: input.comment,
    correction: input.correction,
    source: 'operator',
    scope,
  });
  materializeExecutionFeedbackCandidate({
    feedback,
    procedureId: `dot-semantic-judgment:${input.dot_id}`,
    scope,
  });
}

export function latestReconciliationsByRef(
  rows: readonly DotSemanticReconciliationRow[]
): DotSemanticReconciliationRow[] {
  const byRef = new Map<string, DotSemanticReconciliationRow>();
  for (const row of rows) {
    byRef.delete(row.action_ref);
    byRef.set(row.action_ref, row);
  }
  return [...byRef.values()];
}

/**
 * Reconcile semantic judgments against human approval/rejection feedback and
 * measured execution outcomes. Re-reconciles if delayed `outcomes.jsonl` verdicts
 * arrive after initial human feedback, and emits distill candidates on mismatches.
 */
export async function reconcileDotSemanticFeedback(
  charter: DotCharter,
  deps: DotSemanticLoopDeps = {}
): Promise<DotSemanticReconciliationRow[]> {
  const judgments = readDotSemanticJudgmentLedger(charter, deps);
  if (judgments.length === 0) return [];
  const feedbackRows = readDotFeedback(charter.dot_id, deps);
  if (feedbackRows.length === 0) return [];
  const latestByRef = new Map<string, DotSemanticReconciliationRow>(
    readDotSemanticReconciliations(charter, deps).map((row) => [row.action_ref, row])
  );
  const outcomes = new Map<string, DotOutcomeRow>(
    [
      ...streamJsonLines<DotOutcomeRow>(ledgerAbs(charter, DOT_OUTCOMES_FILE, deps.rootDir), {
        onMalformed: 'skip',
      }),
    ]
      .filter((row) => row?.dot_id === charter.dot_id && typeof row.action_ref === 'string')
      .map((row) => [row.action_ref, row])
  );

  const appended: DotSemanticReconciliationRow[] = [];
  const nowIso = (deps.now?.() ?? new Date()).toISOString();

  for (const entry of feedbackRows) {
    if (!isSettledHumanDecision(entry)) continue;
    const prev = latestByRef.get(entry.action_ref);
    const outcomeRow = outcomes.get(entry.action_ref);
    if (prev && (prev.execution_outcome ?? undefined) === (outcomeRow?.verdict ?? undefined)) {
      continue;
    }
    const match = findMatchingJudgment(judgments, entry);
    if (!match?.verdict) continue;

    const regressed = outcomeRow?.verdict === 'regressed';
    const disposition = match.verdict.disposition;
    const falseApply =
      disposition === 'apply_precedent' && (entry.outcome === 'rejected' || regressed);
    const agree =
      !falseApply &&
      (disposition === 'apply_precedent'
        ? entry.outcome === 'approved' && !regressed
        : entry.outcome === 'rejected');
    const mismatchKind = falseApply ? 'false_apply' : agree ? undefined : 'over_cautious';

    const row: DotSemanticReconciliationRow = {
      dot_id: charter.dot_id,
      action_ref: entry.action_ref,
      action_id: entry.action_id,
      title: entry.title.slice(0, 200),
      judgment_disposition: disposition,
      human_outcome: entry.outcome,
      ...(outcomeRow ? { execution_outcome: outcomeRow.verdict } : {}),
      agree,
      false_apply: falseApply,
      ...(mismatchKind ? { mismatch_kind: mismatchKind } : {}),
      recorded_at: nowIso,
    };

    appendScopedRow(charter, DOT_SEMANTIC_RECONCILIATION_FILE, row, deps.rootDir);
    latestByRef.set(entry.action_ref, row);
    appended.push(row);

    const newlyMismatched = !prev
      ? !agree || falseApply
      : (!agree && prev.agree) || (falseApply && !prev.false_apply);

    if (newlyMismatched) {
      const comment = falseApply
        ? `Semantic judgment predicted apply_precedent for "${entry.title}" (${entry.action_id}), but operator=${entry.outcome} outcome=${outcomeRow?.verdict ?? 'pending'}.`
        : `Semantic judgment predicted ${disposition} for "${entry.title}" (${entry.action_id}), but operator approved.`;
      const correction =
        match.verdict.suggested_improvement ??
        (falseApply
          ? 'Tighten semantic judgment rubric / rejection sensitivity for this dot.'
          : 'Calibrate semantic judgment precedent matching to avoid unnecessary escalation.');
      try {
        const emit = deps.recordDistillFeedback ?? emitDistillFeedbackDefault;
        await emit({
          dot_id: charter.dot_id,
          action_id: entry.action_id,
          action_ref: entry.action_ref,
          outcome: 'dissatisfied',
          comment,
          correction,
          scope: charter.scope,
        });
      } catch (error) {
        logger.warn(
          `[dot-semantic-loop] distill feedback emission failed for ${charter.dot_id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  return appended;
}

function buildNextActionHint(params: {
  mode: 'off' | 'shadow' | 'advisory';
  evaluated: number;
  reconciledCount: number;
  falseApplyCount: number;
  rejectionStreak: number;
  recentRegressedCount: number;
  policy: SemanticRelaxationPolicy;
  blockedReason?: string;
}): string {
  const {
    mode,
    evaluated,
    reconciledCount,
    falseApplyCount,
    rejectionStreak,
    recentRegressedCount,
    policy,
    blockedReason,
  } = params;
  if (mode === 'off') {
    return 'Enable semantic_judgment mode ("shadow") in dot charter to begin non-blocking observation.';
  }
  if (mode === 'shadow') {
    if (evaluated === 0) {
      return 'Await next wake with delivered proposals to collect shadow semantic judgments.';
    }
    if (reconciledCount < policy.min_decisions) {
      return `Continue shadow observation; reconcile ${policy.min_decisions - reconciledCount} more human decision(s) before considering advisory mode.`;
    }
    if (
      falseApplyCount > policy.max_false_apply ||
      rejectionStreak > 0 ||
      recentRegressedCount > 0
    ) {
      return 'Resolve recorded semantic judgment mismatches and inspect distill feedback before promoting to advisory.';
    }
    return 'Shadow quality thresholds met; safe to promote semantic_judgment.mode to "advisory".';
  }
  if (!blockedReason) {
    return 'Advisory approve->notify relaxation is active for fresh apply_precedent verdicts.';
  }
  if (falseApplyCount > policy.max_false_apply || rejectionStreak > 0 || recentRegressedCount > 0) {
    return 'Inspect emitted distill feedback candidates and earn clean approvals after fixing the mismatch.';
  }
  if (reconciledCount < policy.min_decisions) {
    return `Record ${policy.min_decisions - reconciledCount} more clean human approval(s) to unlock approve->notify relaxation.`;
  }
  return `Address blocker (${blockedReason}) to re-enable approve->notify relaxation.`;
}

export function dotSemanticJudgmentMetrics(
  charter: DotCharter,
  deps: Pick<DotSemanticLoopDeps, 'rootDir' | 'now' | 'policy'> = {}
): DotSemanticJudgmentMetrics {
  const mode = charter.runtime.semantic_judgment?.mode ?? 'off';
  const policy: SemanticRelaxationPolicy = {
    ...DEFAULT_SEMANTIC_RELAXATION_POLICY,
    ...(deps.policy ?? {}),
  };
  const ledger = readDotSemanticJudgmentLedger(charter, deps);
  const reconciled = latestReconciliationsByRef(readDotSemanticReconciliations(charter, deps));
  const feedback = readDotFeedback(charter.dot_id, deps);
  const outcomes = [
    ...streamJsonLines<DotOutcomeRow>(ledgerAbs(charter, DOT_OUTCOMES_FILE, deps.rootDir), {
      onMalformed: 'skip',
    }),
  ].filter((row) => row?.dot_id === charter.dot_id && typeof row.verdict === 'string');

  const evaluated = ledger.filter((row) => row.status === 'evaluated').length;
  const unavailable = ledger.length - evaluated;
  const agreed = reconciled.filter((row) => row.agree).length;
  const agreementRate = reconciled.length === 0 ? 0 : agreed / reconciled.length;
  const falseApplyCount = reconciled.filter((row) => row.false_apply).length;
  const primaryRouteCount = ledger.filter((row) => row.route === 'primary').length;
  const fallbackRouteCount = ledger.filter((row) => row.route === 'fallback').length;
  const routedTotal = primaryRouteCount + fallbackRouteCount;
  const primaryRouteRate = routedTotal > 0 ? primaryRouteCount / routedTotal : null;

  let lastProvider: string | undefined;
  let lastModel: string | undefined;
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i].provider) {
      lastProvider = ledger[i].provider;
      lastModel = ledger[i].model;
      break;
    }
  }

  let rejectionStreak = 0;
  for (let i = feedback.length - 1; i >= 0; i--) {
    if (feedback[i].outcome === 'rejected') rejectionStreak++;
    else if (isSettledHumanDecision(feedback[i])) break;
  }

  const judgedOutcomes = outcomes.filter((row) => row.verdict !== 'unmeasurable');
  const improvedCount = judgedOutcomes.filter((row) => row.verdict === 'improved').length;
  const outcomeSuccessRate =
    judgedOutcomes.length === 0 ? 1 : improvedCount / judgedOutcomes.length;
  const recentRegressedCount = judgedOutcomes
    .slice(-5)
    .filter((row) => row.verdict === 'regressed').length;

  let blockedReason: string | undefined;
  if (mode !== 'advisory') blockedReason = `mode is ${mode}, not advisory`;
  else if (reconciled.length < policy.min_decisions)
    blockedReason = `reconciled decisions ${reconciled.length}/${policy.min_decisions}`;
  else if (agreementRate < policy.min_agreement)
    blockedReason = `agreement ${Math.round(agreementRate * 100)}% < ${Math.round(policy.min_agreement * 100)}%`;
  else if (falseApplyCount > policy.max_false_apply)
    blockedReason = `false_apply count ${falseApplyCount} > ${policy.max_false_apply}`;
  else if (rejectionStreak > 0)
    blockedReason = `recent operator rejection streak (${rejectionStreak})`;
  else if (recentRegressedCount > 0)
    blockedReason = `recent regressed execution outcome (${recentRegressedCount})`;
  else if (judgedOutcomes.length > 0 && outcomeSuccessRate < policy.min_outcome_success)
    blockedReason = `outcome success ${Math.round(outcomeSuccessRate * 100)}% < ${Math.round(policy.min_outcome_success * 100)}%`;

  const nextAction = buildNextActionHint({
    mode,
    evaluated,
    reconciledCount: reconciled.length,
    falseApplyCount,
    rejectionStreak,
    recentRegressedCount,
    policy,
    blockedReason,
  });

  return {
    mode,
    judgments: ledger.length,
    evaluated,
    unavailable,
    reconciled: reconciled.length,
    agreed,
    agreement_rate: agreementRate,
    false_apply_count: falseApplyCount,
    recent_rejection_streak: rejectionStreak,
    outcomes_judged: judgedOutcomes.length,
    outcome_success_rate: outcomeSuccessRate,
    recent_regressed_count: recentRegressedCount,
    relaxation_eligible: !blockedReason,
    ...(blockedReason ? { relaxation_blocked_reason: blockedReason } : {}),
    ...(lastProvider ? { last_provider: lastProvider } : {}),
    ...(lastModel ? { last_model: lastModel } : {}),
    primary_route_count: primaryRouteCount,
    fallback_route_count: fallbackRouteCount,
    primary_route_rate: primaryRouteRate,
    next_action: nextAction,
  };
}

function latestJudgmentForProposal(
  charter: DotCharter,
  proposal: DotProposal,
  deps: Pick<DotSemanticLoopDeps, 'rootDir'>
): DotSemanticJudgmentRecord | undefined {
  const ledger = readDotSemanticJudgmentLedger(charter, deps);
  if (ledger.length === 0) return undefined;
  const fingerprint = dotProposalFingerprint(proposal);
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i].proposal_hash === fingerprint) return ledger[i];
  }
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (ledger[i].action_id === proposal.action_id) return ledger[i];
  }
  return undefined;
}

/**
 * Evidence-backed relaxer: in `advisory` mode, when metrics qualify and the
 * latest semantic judgment is a fresh `apply_precedent` verdict, proposes
 * relaxing `approve -> notify` via DOT_SEMANTIC_APPROVE_TO_NOTIFY_EXCEPTION.
 */
export function dotSemanticJudgmentDecisionRelaxer(
  deps: Omit<DotSemanticLoopDeps, 'rootDir' | 'now'> = {}
): DotDecisionRelaxer {
  return {
    id: 'semantic-judgment',
    relax(
      charter: DotCharter,
      proposal: DotProposal,
      gate: AutonomousOpsGateResult,
      _floor,
      ctx: DotExtCtx
    ) {
      if (charter.runtime.semantic_judgment?.mode !== 'advisory') return undefined;
      if (gate.decision !== 'approve' || gate.shadow) return undefined;
      if ((gate.escalations ?? []).some((rule) => HARD_ESCALATIONS.has(rule))) return undefined;
      if ((gate.highRiskPathMatches ?? []).length > 0) return undefined;
      if ((gate.axes?.reversibility ?? 3) >= 2) return undefined;

      const d = { ...deps, rootDir: ctx.rootDir, now: ctx.now };
      const metrics = dotSemanticJudgmentMetrics(charter, d);
      if (!metrics.relaxation_eligible) return undefined;

      const latest = latestJudgmentForProposal(charter, proposal, d);
      if (
        !latest ||
        latest.status !== 'evaluated' ||
        latest.verdict?.disposition !== 'apply_precedent'
      ) {
        return undefined;
      }
      const nowMs = ctx.now().getTime();
      const expiresAt = Date.parse(latest.expires_at ?? '');
      if (!Number.isFinite(expiresAt) || nowMs >= expiresAt) {
        return undefined;
      }

      return {
        decision: 'notify',
        reason: `semantic_judgment apply_precedent (${Math.round(metrics.agreement_rate * 100)}% agreement over ${metrics.reconciled} decisions)`,
        exception: DOT_SEMANTIC_APPROVE_TO_NOTIFY_EXCEPTION,
      };
    },
  };
}

export function dotSemanticJudgmentStatusSection(
  deps: Omit<DotSemanticLoopDeps, 'rootDir' | 'now'> = {}
): DotStatusSection {
  return {
    id: 'semantic_judgment',
    collect(charter, ctx) {
      const m = dotSemanticJudgmentMetrics(charter, {
        ...deps,
        rootDir: ctx.rootDir,
        now: ctx.now,
      });
      return { ...m };
    },
  };
}

export function dotSemanticJudgmentDigestSection(
  deps: Omit<DotSemanticLoopDeps, 'rootDir' | 'now'> = {}
): DotDigestSection {
  return {
    id: 'semantic_judgment',
    lines(charter, _since, ctx) {
      const m = dotSemanticJudgmentMetrics(charter, {
        ...deps,
        rootDir: ctx.rootDir,
        now: ctx.now,
      });
      if (m.mode === 'off' && m.judgments === 0) return [];
      const pct = Math.round(m.agreement_rate * 100);
      const status = m.relaxation_eligible
        ? 'advisory relaxation active (approve->notify eligible)'
        : `held (${m.relaxation_blocked_reason ?? 'observing'})`;
      const providerTag = m.last_provider ? `, provider=${m.last_provider}` : '';
      const routeTag =
        m.primary_route_count + m.fallback_route_count > 0
          ? `, route=${m.primary_route_count} primary/${m.fallback_route_count} fallback`
          : '';
      return [
        `Semantic judgment [${m.mode}]: ${m.evaluated}/${m.judgments} evaluated, ${m.reconciled} reconciled (${pct}% agreement, ${m.false_apply_count} false-apply${providerTag}${routeTag}) — ${status}. Next: ${m.next_action}`,
      ];
    },
  };
}
