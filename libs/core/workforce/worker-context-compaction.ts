/**
 * Worker Context Auto-Compaction (OH-01) — token-window-based two-stage
 * compaction for long-running worker loops, modeled on OpenHarness
 * `services/compact/`:
 *
 *   1. microcompact — no LLM: elide old tool_result bodies, keeping the most
 *      recent N intact and never separating a tool_use from its tool_result.
 *   2. LLM summary — summarize the older history into a bounded `<summary>`
 *      block persisted as an artifact.
 *
 * A structured carryover (goal / active_artifacts / verified_state /
 * next_step) survives the compaction boundary as data — its fidelity does not
 * depend on the summarizer — and is persisted to MissionWorkingMemory when a
 * mission is in scope. Three consecutive summary failures disable
 * auto-compaction and surface `needs_attention`.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import {
  writeCompactionSnapshot,
  discardUncommittedCompactionSnapshot,
  purgeJournalCompactions,
  type CompactionSnapshotReceipt,
} from './worker-compaction-snapshot.js';
import type { WorkerStateJournal } from './worker-state-journal.js';
import { logger } from '../core.js';
import {
  resolveContextWindowProfile,
  type ContextWindowProfile,
} from './context-window-profile.js';
export {
  resolveContextWindowProfile,
  type ContextWindowProfile,
} from './context-window-profile.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { readTextFile } from '../foundation/text.js';
import { metrics } from '../metrics.js';
import type { MissionWorkingMemory } from '../mission/mission-working-memory.js';
import { pathResolver } from '../path-resolver.js';
import {
  CompactionSummaryTimeout,
  runSummaryWithDeadline,
  persistIncompleteHandoff,
} from './worker-compaction-recovery.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from '../secure-io.js';
import { notifyAllDynamicInjectionRegistries } from '../dynamic-injection.js';
import { fireLifecycleHooks, getDefaultLifecycleHookEngine } from '../lifecycle-hook-engine.js';
import { ensureTrustedExternalHooksRegistered } from '../external-hook-discovery.js';
import { getDefaultWorkerEventStream } from './worker-event-stream.js';
import type { ScopeContext } from '../scope-context.js';
import { physicalScopedPath } from '../physical-namespace.js';
import { checkProviderEgress } from '../provider/provider-egress-gate.js';
import {
  withReasoningPayloadScope,
  type ReasoningPayloadScope,
} from '../reasoning/reasoning-egress-scope.js';

export type WorkerContextRole = 'system' | 'user' | 'assistant' | 'tool_use' | 'tool_result';

export interface WorkerContextMessage {
  role: WorkerContextRole;
  content: string;
  /** Links a tool_use to its tool_result; compaction never splits the pair. */
  pairId?: string;
  /** Pinned messages (goal, system framing) are never elided or summarized away. */
  pinned?: boolean;
  /** PI-04: a summary entry can carry its verbatim tail for standalone recovery. */
  retained_tail?: WorkerContextMessage[];
}

/** KC-06: a still-running delegated background task surfaced across the compaction boundary. */
export interface ActiveBackgroundTaskRef {
  delegation_id: string;
  instruction_excerpt: string;
  started_at: string;
}

/** Bound for `active_background_tasks` in the carryover (kimi-cli `build_active_task_snapshot`). */
export const MAX_CARRYOVER_BACKGROUND_TASKS = 8;

/** Structured work state that must survive compaction independent of LLM quality. */
export interface CompactionCarryover {
  goal: string;
  active_artifacts: string[];
  verified_state: string[];
  next_step: string;
  /** KC-06: still-running delegated tasks re-injected post-compaction (≤8). */
  active_background_tasks?: ActiveBackgroundTaskRef[];
  /** PI-04: cumulative file context supplied to update-style summaries. */
  read_files?: string[];
  modified_files?: string[];
}

export type CompactionReason = 'manual' | 'threshold' | 'overflow';

export interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface CompactionSummaryContext {
  previousSummary?: string;
  details: CompactionDetails;
  retainedTail: WorkerContextMessage[];
  reason: CompactionReason;
  /** Cancellation belongs to this attempt, never a reusable global controller. */
  signal?: AbortSignal;
  /** Only meaningful streamed progress should refresh the idle deadline. */
  reportProgress?: () => void;
  attemptId?: number;
}

export interface CompactionEvent {
  name: 'compact.before' | 'compact.after' | 'compact.summary_failed' | 'compact.disabled';
  attributes: Record<string, string | number | boolean>;
}

export interface CompactWorkerContextOptions {
  /** Explicit scoped raw-history retention; no publication or memory promotion. */
  durability?: { journal: WorkerStateJournal; retentionMs?: number; now?: () => number };
  profile?: Partial<ContextWindowProfile>;
  /** Recent tool_result messages kept verbatim by microcompact. Default 5. */
  keepRecentToolResults?: number;
  /** LLM summary stage; omit to run microcompact only. */
  summarize?: (transcript: string, context?: CompactionSummaryContext) => Promise<string>;
  carryover?: CompactionCarryover;
  missionId?: string;
  taskId?: string;
  writerAgent?: string;
  /** Carryover persistence target (mission-scoped). */
  workingMemory?: MissionWorkingMemory;
  /** Absolute directory for the summary artifact. Default: active/shared/tmp/context-compaction/<mission>. */
  summaryDir?: string;
  /** Trace hook — receives compact.before / compact.after events. */
  onEvent?: (event: CompactionEvent) => void;
  recordArtifact?: (artifactPath: string, description: string) => void;
  /** Compact even when under threshold (reactive prompt-too-long path). */
  force?: boolean;
  /** Canonical scope for summary persistence and tenant egress. */
  scope?: ScopeContext;
  /** Provider used by the summary callback, when known. */
  summaryProvider?: string;
  /** Ambient payload scope applied while the summary callback calls a provider. */
  summaryReasoningScope?: ReasoningPayloadScope;
  /** Token usage measured by the last provider call, used as a hybrid anchor. */
  lastProviderUsageTokens?: number;
  /** Number of leading messages represented by the provider usage anchor. */
  providerUsageMessageCount?: number;
  /** Previous update-summary text, when the caller has it outside the transcript. */
  previousSummary?: string;
  /** Cumulative file context for the update-summary prompt. */
  details?: Partial<CompactionDetails>;
  /** Explicit reason; reactive overflow compaction sets this automatically. */
  reason?: CompactionReason;
  /** Compaction-local deadlines; progress refreshes idle only, never the total ceiling. */
  summaryTimeoutMs?: number;
  summaryIdleTimeoutMs?: number;
  signal?: AbortSignal;
  /** Trusted compactor ownership fence, checked before publishing any result. */
  commitGuard?: () => boolean;
  attemptId?: number;
  /** Trusted degraded mode after repeated summary stalls. No provider call is made. */
  forceDeterministicHandoff?: boolean;
  deterministicHandoffOnTimeout?: boolean;
}

export interface ContextTokenEstimate {
  tokens: number;
  strategy: 'char' | 'hybrid';
  usageTokens?: number;
  estimatedTrailingTokens: number;
  trailingMessageCount: number;
}

export interface CompactWorkerContextResult {
  snapshotReceipt?: CompactionSnapshotReceipt;
  durabilityError?: 'checkpoint_unavailable' | 'checkpoint_cleanup_required';
  messages: WorkerContextMessage[];
  compacted: boolean;
  stage: 'none' | 'microcompact' | 'summary' | 'deterministic_handoff';
  tokensBefore: number;
  tokensAfter: number;
  thresholdTokens: number;
  /** Repo-relative path of the persisted summary, when the summary stage ran. */
  summaryArtifactPath?: string;
  /** Set when the summarize stage was attempted and failed (microcompact still applied). */
  summaryError?: string;
  summaryFailureKind?: 'timeout' | 'error';
  /** Deterministic handoffs preserve anchors, not a verified account of completed work. */
  incomplete?: boolean;
  tokenEstimate: ContextTokenEstimate;
  reason?: CompactionReason;
  /** Tail copied into the summary entry and available for standalone recovery. */
  retainedTail: WorkerContextMessage[];
  details: CompactionDetails;
}

const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 5;
const ELIDE_MIN_CHARS = 200;
/** Fraction of the threshold kept as verbatim recent history by the summary stage. */
const SUMMARY_TAIL_FRACTION = 0.25;
const MAX_CONSECUTIVE_SUMMARY_FAILURES = 3;
const DETERMINISTIC_HANDOFF_AFTER_STALLS = 2;

const UPDATE_SUMMARY_PROMPT_PATH = pathResolver.knowledge(
  'product/prompts/worker-context-update-summary.md'
);
const FALLBACK_UPDATE_SUMMARY_PROMPT = [
  'Update the existing worker context summary from the new transcript.',
  'Preserve completed decisions and keep In Progress items explicit.',
  'Return a concise summary that can stand alone after compaction.',
].join('\n');

/** Provider "prompt too long" detection for the reactive compaction path. */
export const PROMPT_TOO_LONG_PATTERN =
  /prompt (?:is )?too long|context window|maximum context length|context_length_exceeded|input (?:is )?too (?:large|long)|too many tokens|exceeds? .*token|\[CONTEXT_LIMIT\]/i;

export function isPromptTooLongError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '');
  return PROMPT_TOO_LONG_PATTERN.test(message);
}

export function compactionThresholdTokens(profile: ContextWindowProfile): number {
  return Math.max(1024, profile.contextWindowTokens - profile.reserveTokens - profile.bufferTokens);
}

/**
 * The legacy estimate remains intentionally conservative for callers outside
 * compaction. PI-04's hybrid path uses a separate /4 estimate for its
 * unmeasured tail below.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function estimateHybridTailTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateContextTokenDetails(
  messages: readonly WorkerContextMessage[],
  options: { providerUsageTokens?: number; providerUsageMessageCount?: number } = {}
): ContextTokenEstimate {
  const usageTokens = options.providerUsageTokens;
  if (typeof usageTokens === 'number' && Number.isFinite(usageTokens) && usageTokens >= 0) {
    const prefixCount = Math.max(
      0,
      Math.min(messages.length, Math.floor(options.providerUsageMessageCount ?? messages.length))
    );
    const estimatedTrailingTokens = messages
      .slice(prefixCount)
      .reduce((sum, message) => sum + estimateHybridTailTokens(message.content), 0);
    return {
      tokens: Math.ceil(usageTokens) + estimatedTrailingTokens,
      strategy: 'hybrid',
      usageTokens: Math.ceil(usageTokens),
      estimatedTrailingTokens,
      trailingMessageCount: messages.length - prefixCount,
    };
  }
  const estimatedTrailingTokens = messages.reduce(
    (sum, message) => sum + estimateTokens(message.content),
    0
  );
  return {
    tokens: estimatedTrailingTokens,
    strategy: 'char',
    estimatedTrailingTokens,
    trailingMessageCount: messages.length,
  };
}

export function estimateContextTokens(
  messages: readonly WorkerContextMessage[],
  options: { providerUsageTokens?: number; providerUsageMessageCount?: number } = {}
): number {
  return estimateContextTokenDetails(messages, options).tokens;
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function resolveCompactionDetails(options: CompactWorkerContextOptions): CompactionDetails {
  return {
    readFiles: uniqueStrings([
      ...(options.carryover?.read_files ?? []),
      ...(options.details?.readFiles ?? []),
    ]),
    modifiedFiles: uniqueStrings([
      ...(options.carryover?.modified_files ?? []),
      ...(options.details?.modifiedFiles ?? []),
    ]),
  };
}

function extractPreviousSummary(messages: readonly WorkerContextMessage[]): string | undefined {
  const summaryMessage = [...messages]
    .reverse()
    .find((message) => message.content.includes('<summary>'));
  if (!summaryMessage) return undefined;
  const openIndex = summaryMessage.content.indexOf('<summary>');
  const closeIndex = summaryMessage.content.indexOf('</summary>', openIndex);
  return openIndex >= 0 && closeIndex > openIndex
    ? summaryMessage.content.slice(openIndex + '<summary>'.length, closeIndex).trim() || undefined
    : undefined;
}

export function isRegularUpdateSummaryPromptPath(filePath: string): boolean {
  if (!safeExistsSync(filePath)) return false;
  try {
    return safeLstat(filePath).isFile();
  } catch {
    return false;
  }
}

function loadUpdateSummaryPrompt(): string {
  if (!isRegularUpdateSummaryPromptPath(UPDATE_SUMMARY_PROMPT_PATH)) {
    return FALLBACK_UPDATE_SUMMARY_PROMPT;
  }
  return readTextFile(UPDATE_SUMMARY_PROMPT_PATH).trim();
}

function renderUpdateSummaryInput(transcript: string, context: CompactionSummaryContext): string {
  return [
    loadUpdateSummaryPrompt(),
    '',
    '## Previous summary',
    context.previousSummary || '(none — establish the first summary)',
    '',
    '## Cumulative file context',
    JSON.stringify(context.details),
    '',
    `## Compaction reason\n${context.reason}`,
    '',
    '## New transcript',
    transcript,
  ].join('\n');
}

export function renderCarryoverBlock(
  carryover: CompactionCarryover,
  details?: CompactionDetails
): string {
  const list = (values: string[]): string =>
    values.length > 0 ? values.map((value) => `  - ${value}`).join('\n') : '  - none';
  const backgroundTasks = (carryover.active_background_tasks ?? []).slice(
    0,
    MAX_CARRYOVER_BACKGROUND_TASKS
  );
  return [
    '<task_focus_state>',
    `goal: ${carryover.goal}`,
    'active_artifacts:',
    list(carryover.active_artifacts),
    'verified_state:',
    list(carryover.verified_state),
    `next_step: ${carryover.next_step}`,
    ...(details && (details.readFiles.length > 0 || details.modifiedFiles.length > 0)
      ? [
          `read_files: ${details.readFiles.join(', ') || 'none'}`,
          `modified_files: ${details.modifiedFiles.join(', ') || 'none'}`,
        ]
      : []),
    ...(backgroundTasks.length > 0
      ? [
          'active_background_tasks:',
          list(
            backgroundTasks.map(
              (task) =>
                `${task.delegation_id} (started ${task.started_at}): ${task.instruction_excerpt}`
            )
          ),
        ]
      : []),
    '</task_focus_state>',
  ].join('\n');
}

export const CARRYOVER_WORKING_MEMORY_KEY = 'compaction:carryover';

export function persistCarryover(input: {
  workingMemory: MissionWorkingMemory;
  missionId: string;
  carryover: CompactionCarryover;
  writerAgent?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}): void {
  try {
    input.workingMemory.write({
      mission_id: input.missionId,
      scope: 'agent',
      key: CARRYOVER_WORKING_MEMORY_KEY,
      value: JSON.stringify(input.carryover),
      writer_agent: input.writerAgent || 'worker-context-compaction',
      task_id: input.taskId,
      metadata: input.metadata,
    });
  } catch (error) {
    logger.warn(
      `[context-compaction] carryover persistence failed (non-fatal): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export function loadCarryover(
  workingMemory: MissionWorkingMemory,
  missionId: string
): CompactionCarryover | null {
  try {
    const entries = workingMemory
      .list({ missionId, scope: 'agent' })
      .filter((entry) => entry.key === CARRYOVER_WORKING_MEMORY_KEY);
    const latest = entries[entries.length - 1];
    if (!latest) return null;
    const parsed = parseSafeJsonInput(
      latest.value,
      'worker compaction carryover'
    ) as CompactionCarryover;
    return parsed && typeof parsed.goal === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Indexes of tool_result messages eligible for microcompact eliding. */
function elidableToolResultIndexes(
  messages: readonly WorkerContextMessage[],
  keepRecent: number
): number[] {
  const toolResultIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'tool_result' && !message.pinned)
    .map(({ index }) => index);
  return toolResultIndexes.slice(0, Math.max(0, toolResultIndexes.length - keepRecent));
}

function microcompact(
  messages: readonly WorkerContextMessage[],
  keepRecent: number
): WorkerContextMessage[] {
  const elidable = new Set(elidableToolResultIndexes(messages, keepRecent));
  return messages.map((message, index) => {
    if (!elidable.has(index) || message.content.length <= ELIDE_MIN_CHARS) return message;
    return {
      ...message,
      content: `[tool_result elided by auto-compaction: ${message.content.length} chars — full output preserved in artifacts]`,
    };
  });
}

/**
 * Pick the start index of the verbatim tail for the summary stage, moved
 * earlier as needed so a tool_result is never separated from its tool_use.
 */
function pairSafeTailStart(
  messages: readonly WorkerContextMessage[],
  tailBudgetTokens: number
): number {
  let start = messages.length;
  let tokens = 0;
  while (start > 0) {
    const candidate = messages[start - 1];
    const candidateTokens = estimateTokens(candidate.content);
    if (tokens + candidateTokens > tailBudgetTokens && tokens > 0) break;
    start -= 1;
    tokens += candidateTokens;
  }
  // Never let the tail begin at a tool_result whose tool_use fell on the
  // summarized side of the boundary.
  while (start > 0) {
    const first = messages[start];
    if (!first || first.role !== 'tool_result' || !first.pairId) break;
    const pairIndex = messages.findIndex(
      (message) => message.role === 'tool_use' && message.pairId === first.pairId
    );
    if (pairIndex >= start || pairIndex < 0) break;
    start = pairIndex;
  }
  return start;
}

function persistSummaryArtifact(input: {
  summary: string;
  carryover?: CompactionCarryover;
  details: CompactionDetails;
  reason: CompactionReason;
  retainedTail: WorkerContextMessage[];
  missionId?: string;
  summaryDir?: string;
  recordArtifact?: (artifactPath: string, description: string) => void;
  scope?: ScopeContext;
}): string | undefined {
  try {
    const missionSlug =
      String(input.missionId || 'shared')
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '-') || 'shared';
    const dir =
      input.summaryDir ||
      (input.scope?.tenant_slug
        ? pathResolver.rootResolve(
            physicalScopedPath('active/shared/tmp/context-compaction', {
              ...input.scope,
              mission_id: input.scope.mission_id || missionSlug,
              scope_kind: input.scope.task_id ? 'task' : 'mission',
            })
          )
        : pathResolver.sharedTmp(path.join('context-compaction', missionSlug)));
    const absolutePath = assertSafeRepositoryPath(
      path.join(dir, `compaction-summary-${crypto.randomUUID()}.md`),
      { allowMissingLeaf: true }
    );
    safeMkdir(path.dirname(absolutePath), { recursive: true });
    const body = [
      '# Auto-compaction summary',
      '',
      input.summary,
      '',
      `compaction_reason: ${input.reason}`,
      `details: ${JSON.stringify(input.details)}`,
      '',
      '<retained_tail>',
      renderTranscriptForSummary(input.retainedTail),
      '</retained_tail>',
      ...(input.carryover ? ['', renderCarryoverBlock(input.carryover)] : []),
      '',
    ].join('\n');
    safeWriteFile(absolutePath, body, { mkdir: true, encoding: 'utf8' });
    const portablePath = pathResolver.toRepoRelative(absolutePath);
    input.recordArtifact?.(portablePath, 'Worker context auto-compaction summary');
    return portablePath;
  } catch (error) {
    logger.warn(
      `[context-compaction] summary artifact persistence failed (non-fatal): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
}

function renderTranscriptForSummary(messages: readonly WorkerContextMessage[]): string {
  return messages.map((message) => `[${message.role}]\n${message.content}`).join('\n\n');
}

/**
 * Two-stage compaction of a worker transcript. Stage 2 (LLM summary) runs only
 * when microcompact alone does not bring the context under threshold and a
 * summarizer is supplied; a summarizer failure degrades to the microcompact
 * result and is reported via `summaryError` instead of throwing.
 */
export async function compactWorkerContext(
  messages: readonly WorkerContextMessage[],
  options: CompactWorkerContextOptions = {}
): Promise<CompactWorkerContextResult> {
  const profile = resolveContextWindowProfile(options.profile);
  const thresholdTokens = compactionThresholdTokens(profile);
  const reason = options.reason || (options.force ? 'manual' : 'threshold');
  const details = resolveCompactionDetails(options);
  const carryover = options.carryover
    ? {
        ...options.carryover,
        ...(details.readFiles.length > 0 ? { read_files: details.readFiles } : {}),
        ...(details.modifiedFiles.length > 0 ? { modified_files: details.modifiedFiles } : {}),
      }
    : undefined;
  const tokenEstimate = estimateContextTokenDetails(messages, {
    providerUsageTokens: options.lastProviderUsageTokens,
    providerUsageMessageCount: options.providerUsageMessageCount,
  });
  const tokensBefore = tokenEstimate.tokens;
  const canCommit = () => !options.signal?.aborted && options.commitGuard?.() !== false;
  const unchanged = (): CompactWorkerContextResult => ({
    messages: [...messages],
    compacted: false,
    stage: 'none',
    tokensBefore,
    tokensAfter: tokensBefore,
    thresholdTokens,
    tokenEstimate,
    retainedTail: [],
    details,
    reason,
  });
  if (!canCommit()) return unchanged();

  if (!options.force && tokensBefore <= thresholdTokens) {
    return {
      messages: [...messages],
      compacted: false,
      stage: 'none',
      tokensBefore,
      tokensAfter: tokensBefore,
      thresholdTokens,
      tokenEstimate,
      retainedTail: [],
      details,
    };
  }

  options.onEvent?.({
    name: 'compact.before',
    attributes: {
      tokens_before: tokensBefore,
      threshold_tokens: thresholdTokens,
      estimate_strategy: tokenEstimate.strategy,
      ...(tokenEstimate.usageTokens === undefined
        ? {}
        : { usage_tokens_anchor: tokenEstimate.usageTokens }),
      estimated_trailing_tokens: tokenEstimate.estimatedTrailingTokens,
      forced: Boolean(options.force),
      reason,
      ...(options.missionId ? { mission_id: options.missionId } : {}),
    },
  });
  // KC-04 pre_compact hooks are observational: compaction is itself a safety
  // mechanism, so a hook block verdict must not stop it. KC-02: mirror onto
  // the worker event stream (best-effort).
  try {
    // DH-16: trusted project hook configs join the engine (opt-in, inert by default).
    ensureTrustedExternalHooksRegistered();
  } catch {
    /* external hooks are additive; a bootstrap failure must not stop compaction */
  }
  await fireLifecycleHooks(getDefaultLifecycleHookEngine(), 'pre_compact', {
    ...(options.missionId
      ? { matcher_value: options.missionId, mission_id: options.missionId }
      : {}),
    tokens_before: tokensBefore,
    threshold_tokens: thresholdTokens,
  });
  if (!canCommit()) return unchanged();
  try {
    getDefaultWorkerEventStream().emit(
      'compaction_begin',
      { tokens_before: tokensBefore, threshold_tokens: thresholdTokens },
      options.missionId ? { mission_id: options.missionId } : undefined
    );
  } catch {
    /* stream projection stays best-effort */
  }

  // Stage 1 — microcompact (LLM-free).
  const keepRecent = options.keepRecentToolResults ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS;
  let compactedMessages = microcompact(messages, keepRecent);
  let stage: CompactWorkerContextResult['stage'] = 'microcompact';
  let summaryArtifactPath: string | undefined;
  let summaryError: string | undefined;
  let summaryFailureKind: CompactWorkerContextResult['summaryFailureKind'];
  let incomplete = false;
  let retainedTail: WorkerContextMessage[] = [];

  // Stage 2 — LLM summary over the older history.
  const stillOver = estimateContextTokens(compactedMessages) > thresholdTokens;
  if (stillOver && (options.summarize || options.forceDeterministicHandoff)) {
    const pinned = compactedMessages.filter((message) => message.pinned);
    const flow = compactedMessages.filter((message) => !message.pinned);
    const tailBudget = Math.max(1, Math.floor(thresholdTokens * SUMMARY_TAIL_FRACTION));
    const tailStart = pairSafeTailStart(flow, tailBudget);
    const head = flow.slice(0, tailStart);
    const tail = flow.slice(tailStart);
    retainedTail = tail;
    const deterministicHandoff = () => {
      if (!canCommit()) return false;
      const archive = persistIncompleteHandoff(messages, options, details, carryover);
      if (!archive || !canCommit()) return false;
      summaryArtifactPath = archive;
      compactedMessages = [
        ...pinned,
        {
          role: 'user',
          content: `INCOMPLETE DETERMINISTIC HANDOFF\nThe summarizer stalled. This is not a verified narrative of completed work.\nPreserve the pinned goal and structured carryover; verify current state before acting.\nExact prior context: ${archive}`,
          retained_tail: tail,
        },
        ...tail,
      ];
      stage = 'deterministic_handoff';
      incomplete = true;
      return true;
    };
    if (head.length > 0) {
      if (options.forceDeterministicHandoff) {
        if (!deterministicHandoff()) {
          summaryError = 'Deterministic handoff requires an available scoped archive';
          summaryFailureKind = 'error';
        }
      } else {
        try {
          if (options.summaryProvider && options.scope) {
            const egress = checkProviderEgress({
              provider: options.summaryProvider,
              dataTier: options.scope.tier,
              ...(options.scope.tenant_slug ? { tenant_slug: options.scope.tenant_slug } : {}),
            });
            if (!egress.allowed) throw new Error(egress.reason || 'summary egress denied');
          }
          const summaryContext: CompactionSummaryContext = {
            ...(options.previousSummary || extractPreviousSummary(messages)
              ? { previousSummary: options.previousSummary || extractPreviousSummary(messages) }
              : {}),
            details,
            retainedTail: tail,
            reason,
          };
          const summaryInput = renderUpdateSummaryInput(
            renderTranscriptForSummary(head),
            summaryContext
          );
          const summary = await runSummaryWithDeadline(async (signal, reportProgress) => {
            const runSummary = () =>
              options.summarize!(summaryInput, {
                ...summaryContext,
                signal,
                reportProgress,
                ...(options.attemptId !== undefined ? { attemptId: options.attemptId } : {}),
              });
            return options.summaryReasoningScope
              ? withReasoningPayloadScope(options.summaryReasoningScope, runSummary)
              : runSummary();
          }, options);
          if (!canCommit()) return unchanged();
          summaryArtifactPath = persistSummaryArtifact({
            summary,
            carryover,
            details,
            reason,
            retainedTail: tail,
            missionId: options.missionId,
            summaryDir: options.summaryDir,
            recordArtifact: options.recordArtifact,
            scope: options.scope,
          });
          const summaryMessage: WorkerContextMessage = {
            role: 'user',
            content: [
              '<summary>',
              summary,
              '</summary>',
              summaryArtifactPath ? `(full summary artifact: ${summaryArtifactPath})` : '',
            ]
              .filter(Boolean)
              .join('\n'),
            retained_tail: tail,
          };
          compactedMessages = [...pinned, summaryMessage, ...tail];
          stage = 'summary';
        } catch (error) {
          if (!canCommit()) return unchanged();
          summaryError = error instanceof Error ? error.message : String(error);
          summaryFailureKind = error instanceof CompactionSummaryTimeout ? 'timeout' : 'error';
          options.onEvent?.({
            name: 'compact.summary_failed',
            attributes: {
              error: summaryError,
              ...(options.missionId ? { mission_id: options.missionId } : {}),
            },
          });
          if (summaryFailureKind === 'timeout' && options.deterministicHandoffOnTimeout)
            deterministicHandoff();
        }
      }
    }
  }

  if (!canCommit()) return unchanged();

  // Carryover survives the boundary as structured data, independent of the
  // summary stage's outcome.
  if (carryover) {
    compactedMessages = [
      ...compactedMessages,
      { role: 'user', content: renderCarryoverBlock(carryover, details), pinned: true },
    ];
  }
  let snapshotReceipt: CompactionSnapshotReceipt | undefined;
  if (options.durability) {
    try {
      if (
        !options.scope ||
        (options.missionId && options.scope.mission_id !== options.missionId) ||
        (options.taskId && options.scope.task_id !== options.taskId)
      )
        throw new Error('Compaction scope is incomplete or contradictory');
      const now = options.durability.now?.() ?? Date.now();
      await purgeJournalCompactions(options.durability.journal, options.scope, now);
      if (!canCommit()) return unchanged();
      snapshotReceipt = await writeCompactionSnapshot({
        source: messages,
        messages: compactedMessages,
        scope: options.scope,
        parent: options.durability.journal.compactionTip(options.scope),
        retentionMs: options.durability.retentionMs,
        now,
        canCommit,
      });
      if (!canCommit()) throw new Error('Snapshot attempt cancelled');
      options.durability.journal.recordCompaction(snapshotReceipt);
    } catch (error) {
      if (snapshotReceipt && options.scope) {
        try {
          if (options.durability.journal.compactionTip(options.scope)?.id !== snapshotReceipt.id)
            await discardUncommittedCompactionSnapshot(snapshotReceipt, options.scope);
        } catch {
          /* An unverified artifact is never deleted by a guessed path. */
        }
      }
      return {
        ...unchanged(),
        ...(canCommit()
          ? {
              durabilityError:
                error instanceof Error &&
                error.message.startsWith('[COMPACTION_CLEANUP_NEEDS_ATTENTION]')
                  ? ('checkpoint_cleanup_required' as const)
                  : ('checkpoint_unavailable' as const),
            }
          : {}),
      };
    }
  }
  if (carryover) {
    if (options.workingMemory && options.missionId) {
      persistCarryover({
        workingMemory: options.workingMemory,
        missionId: options.missionId,
        carryover,
        writerAgent: options.writerAgent,
        taskId: options.taskId,
        metadata: {
          stage,
          tokens_before: tokensBefore,
          threshold_tokens: thresholdTokens,
          estimate_strategy: tokenEstimate.strategy,
          reason,
          details,
          ...(tokenEstimate.usageTokens === undefined
            ? {}
            : { usage_tokens_anchor: tokenEstimate.usageTokens }),
        },
      });
    }
  }

  const tokensAfter = estimateContextTokens(compactedMessages);
  options.onEvent?.({
    name: 'compact.after',
    attributes: {
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      threshold_tokens: thresholdTokens,
      stage,
      reason,
      estimate_strategy: tokenEstimate.strategy,
      estimated_trailing_tokens: tokenEstimate.estimatedTrailingTokens,
      ...(summaryArtifactPath ? { summary_artifact: summaryArtifactPath } : {}),
      ...(summaryError ? { summary_error: summaryError } : {}),
      ...(options.missionId ? { mission_id: options.missionId } : {}),
    },
  });
  await fireLifecycleHooks(getDefaultLifecycleHookEngine(), 'post_compact', {
    ...(options.missionId
      ? { matcher_value: options.missionId, mission_id: options.missionId }
      : {}),
    tokens_before: tokensBefore,
    tokens_after: tokensAfter,
    stage,
  });
  if (!canCommit()) return unchanged();
  try {
    getDefaultWorkerEventStream().emit(
      'compaction_end',
      { tokens_before: tokensBefore, tokens_after: tokensAfter, stage },
      options.missionId ? { mission_id: options.missionId } : undefined
    );
  } catch {
    /* stream projection stays best-effort */
  }
  // KC-08: the compacted transcript lost every earlier injection — reset the
  // registry so one-shot reminders (working principles etc.) re-fire.
  try {
    notifyAllDynamicInjectionRegistries();
  } catch {
    /* injection bookkeeping must not alter compaction behavior */
  }
  try {
    metrics.record('worker:context-compaction', tokensBefore - tokensAfter, 'success', {
      cause: 'compaction',
      stage,
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      mission_id: options.missionId,
    });
  } catch {
    // Metrics are best-effort and must not alter compaction behavior.
  }

  return {
    ...(snapshotReceipt ? { snapshotReceipt } : {}),
    messages: compactedMessages,
    compacted: true,
    stage,
    tokensBefore,
    tokensAfter,
    thresholdTokens,
    summaryArtifactPath,
    summaryError,
    ...(summaryFailureKind ? { summaryFailureKind } : {}),
    ...(incomplete ? { incomplete: true } : {}),
    tokenEstimate,
    reason,
    retainedTail,
    details,
  };
}

/**
 * Stateful wrapper tracking summary failures across a worker's lifetime:
 * after three consecutive failures auto-compaction is disabled and
 * `compact.disabled` (needs_attention) is surfaced once.
 */
export class WorkerContextCompactor {
  private consecutiveSummaryFailures = 0;
  private consecutiveSummaryStalls = 0;
  private disabled = false;
  private generation = 0;
  private activeAttempt?: AbortController;

  constructor(private readonly baseOptions: CompactWorkerContextOptions = {}) {}

  get isDisabled(): boolean {
    return this.disabled;
  }

  async maybeCompact(
    messages: readonly WorkerContextMessage[],
    overrides: Partial<CompactWorkerContextOptions> = {}
  ): Promise<CompactWorkerContextResult> {
    const configured = { ...this.baseOptions, ...overrides };
    const generation = ++this.generation;
    this.activeAttempt?.abort(new Error('Summary attempt superseded'));
    const controller = new AbortController();
    this.activeAttempt = controller;
    const options: CompactWorkerContextOptions = {
      ...configured,
      signal: configured.signal
        ? AbortSignal.any([configured.signal, controller.signal])
        : controller.signal,
      attemptId: generation,
      commitGuard: () => generation === this.generation && configured.commitGuard?.() !== false,
      ...(this.consecutiveSummaryStalls >= DETERMINISTIC_HANDOFF_AFTER_STALLS
        ? { forceDeterministicHandoff: true }
        : {}),
      ...(this.consecutiveSummaryStalls >= DETERMINISTIC_HANDOFF_AFTER_STALLS - 1
        ? { deterministicHandoffOnTimeout: true }
        : {}),
    };
    if (this.disabled) {
      if (this.activeAttempt === controller) this.activeAttempt = undefined;
      const profile = resolveContextWindowProfile(options.profile);
      const tokenEstimate = estimateContextTokenDetails(messages, {
        providerUsageTokens: options.lastProviderUsageTokens,
        providerUsageMessageCount: options.providerUsageMessageCount,
      });
      const tokens = tokenEstimate.tokens;
      return {
        messages: [...messages],
        compacted: false,
        stage: 'none',
        tokensBefore: tokens,
        tokensAfter: tokens,
        thresholdTokens: compactionThresholdTokens(profile),
        tokenEstimate,
        retainedTail: [],
        details: resolveCompactionDetails(options),
      };
    }
    let result: CompactWorkerContextResult;
    try {
      result = await compactWorkerContext(messages, options);
    } finally {
      if (this.activeAttempt === controller) this.activeAttempt = undefined;
    }
    if (generation !== this.generation || options.signal?.aborted)
      return {
        ...result,
        messages: [...messages],
        compacted: false,
        stage: 'none',
        tokensAfter: result.tokensBefore,
      };
    if (!result.compacted) return result;
    if (result.summaryFailureKind === 'timeout') this.consecutiveSummaryStalls++;
    if (result.summaryError) {
      if (result.stage === 'deterministic_handoff') return result;
      this.consecutiveSummaryFailures += 1;
      if (this.consecutiveSummaryFailures >= MAX_CONSECUTIVE_SUMMARY_FAILURES) {
        this.disabled = true;
        logger.warn(
          `[context-compaction] auto-compaction disabled after ${this.consecutiveSummaryFailures} consecutive summary failures — needs_attention`
        );
        options.onEvent?.({
          name: 'compact.disabled',
          attributes: {
            needs_attention: true,
            consecutive_failures: this.consecutiveSummaryFailures,
            ...(options.missionId ? { mission_id: options.missionId } : {}),
          },
        });
      }
    } else if (result.stage === 'summary') {
      this.consecutiveSummaryFailures = 0;
      this.consecutiveSummaryStalls = 0;
    }
    return result;
  }

  /**
   * Reactive path: after a provider "prompt too long" error, force one
   * compaction so the caller can retry exactly once.
   */
  async compactAfterPromptTooLong(
    messages: readonly WorkerContextMessage[],
    error: unknown,
    overrides: Partial<CompactWorkerContextOptions> = {}
  ): Promise<CompactWorkerContextResult | null> {
    if (this.disabled || !isPromptTooLongError(error)) return null;
    return this.maybeCompact(messages, { ...overrides, force: true, reason: 'overflow' });
  }
}
