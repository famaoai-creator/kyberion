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
import { logger } from './core.js';
import { metrics } from './metrics.js';
import type { MissionWorkingMemory } from './mission-working-memory.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { notifyAllDynamicInjectionRegistries } from './dynamic-injection.js';
import { fireLifecycleHooks, getDefaultLifecycleHookEngine } from './lifecycle-hook-engine.js';
import { getDefaultWorkerEventStream } from './worker-event-stream.js';
import type { ScopeContext } from './scope-context.js';
import { physicalScopedPath } from './physical-namespace.js';
import { checkProviderEgress } from './provider-egress-gate.js';

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
}

export interface ContextWindowProfile {
  /** Total model context window, in tokens. */
  contextWindowTokens: number;
  /** Tokens reserved for the model's output. */
  reserveTokens: number;
  /** Safety buffer below the hard limit. */
  bufferTokens: number;
}

export interface CompactionEvent {
  name: 'compact.before' | 'compact.after' | 'compact.summary_failed' | 'compact.disabled';
  attributes: Record<string, string | number | boolean>;
}

export interface CompactWorkerContextOptions {
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
}

export interface ContextTokenEstimate {
  tokens: number;
  strategy: 'char' | 'hybrid';
  usageTokens?: number;
  estimatedTrailingTokens: number;
  trailingMessageCount: number;
}

export interface CompactWorkerContextResult {
  messages: WorkerContextMessage[];
  compacted: boolean;
  stage: 'none' | 'microcompact' | 'summary';
  tokensBefore: number;
  tokensAfter: number;
  thresholdTokens: number;
  /** Repo-relative path of the persisted summary, when the summary stage ran. */
  summaryArtifactPath?: string;
  /** Set when the summarize stage was attempted and failed (microcompact still applied). */
  summaryError?: string;
  tokenEstimate: ContextTokenEstimate;
  reason?: CompactionReason;
  /** Tail copied into the summary entry and available for standalone recovery. */
  retainedTail: WorkerContextMessage[];
  details: CompactionDetails;
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const DEFAULT_RESERVE_TOKENS = 32_000;
const DEFAULT_BUFFER_TOKENS = 8_000;
const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 5;
const ELIDE_MIN_CHARS = 200;
/** Fraction of the threshold kept as verbatim recent history by the summary stage. */
const SUMMARY_TAIL_FRACTION = 0.25;
const MAX_CONSECUTIVE_SUMMARY_FAILURES = 3;
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

function readEnvTokens(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw?.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function resolveContextWindowProfile(
  overrides?: Partial<ContextWindowProfile>
): ContextWindowProfile {
  return {
    contextWindowTokens:
      overrides?.contextWindowTokens ??
      readEnvTokens('KYBERION_CONTEXT_WINDOW_TOKENS') ??
      DEFAULT_CONTEXT_WINDOW_TOKENS,
    reserveTokens:
      overrides?.reserveTokens ??
      readEnvTokens('KYBERION_CONTEXT_RESERVE_TOKENS') ??
      DEFAULT_RESERVE_TOKENS,
    bufferTokens:
      overrides?.bufferTokens ??
      readEnvTokens('KYBERION_CONTEXT_BUFFER_TOKENS') ??
      DEFAULT_BUFFER_TOKENS,
  };
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
  const match = summaryMessage.content.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/u);
  return match?.[1]?.trim() || undefined;
}

function loadUpdateSummaryPrompt(): string {
  if (!safeExistsSync(UPDATE_SUMMARY_PROMPT_PATH)) return FALLBACK_UPDATE_SUMMARY_PROMPT;
  return String(safeReadFile(UPDATE_SUMMARY_PROMPT_PATH, { encoding: 'utf8' }) || '').trim();
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
    const parsed = JSON.parse(latest.value) as CompactionCarryover;
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
    const absolutePath = path.join(dir, `compaction-summary-${crypto.randomUUID()}.md`);
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
  await fireLifecycleHooks(getDefaultLifecycleHookEngine(), 'pre_compact', {
    ...(options.missionId
      ? { matcher_value: options.missionId, mission_id: options.missionId }
      : {}),
    tokens_before: tokensBefore,
    threshold_tokens: thresholdTokens,
  });
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
  let retainedTail: WorkerContextMessage[] = [];

  // Stage 2 — LLM summary over the older history.
  const stillOver = estimateContextTokens(compactedMessages) > thresholdTokens;
  if (stillOver && options.summarize) {
    const pinned = compactedMessages.filter((message) => message.pinned);
    const flow = compactedMessages.filter((message) => !message.pinned);
    const tailBudget = Math.max(1, Math.floor(thresholdTokens * SUMMARY_TAIL_FRACTION));
    const tailStart = pairSafeTailStart(flow, tailBudget);
    const head = flow.slice(0, tailStart);
    const tail = flow.slice(tailStart);
    retainedTail = tail;
    if (head.length > 0) {
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
        const summary = await options.summarize(
          renderUpdateSummaryInput(renderTranscriptForSummary(head), summaryContext),
          summaryContext
        );
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
        summaryError = error instanceof Error ? error.message : String(error);
        options.onEvent?.({
          name: 'compact.summary_failed',
          attributes: {
            error: summaryError,
            ...(options.missionId ? { mission_id: options.missionId } : {}),
          },
        });
      }
    }
  }

  // Carryover survives the boundary as structured data, independent of the
  // summary stage's outcome.
  if (carryover) {
    compactedMessages = [
      ...compactedMessages,
      { role: 'user', content: renderCarryoverBlock(carryover, details), pinned: true },
    ];
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
    messages: compactedMessages,
    compacted: true,
    stage,
    tokensBefore,
    tokensAfter,
    thresholdTokens,
    summaryArtifactPath,
    summaryError,
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
  private disabled = false;

  constructor(private readonly baseOptions: CompactWorkerContextOptions = {}) {}

  get isDisabled(): boolean {
    return this.disabled;
  }

  async maybeCompact(
    messages: readonly WorkerContextMessage[],
    overrides: Partial<CompactWorkerContextOptions> = {}
  ): Promise<CompactWorkerContextResult> {
    const options = { ...this.baseOptions, ...overrides };
    if (this.disabled) {
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
    const result = await compactWorkerContext(messages, options);
    if (!result.compacted) return result;
    if (result.summaryError) {
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
