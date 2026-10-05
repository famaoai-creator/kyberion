/**
 * Bounded front-desk intake routing. Records requests and resolves references,
 * without starting, verifying, approving, cancelling, or steering execution.
 * Only decisions carrying a reply replace the conversation runtime's answer;
 * everything else, including every unresolved reference, stays ordinary chat.
 * Callers supply server-owned state and already-redacted display text.
 */
import {
  captureIntentPhrase,
  matchesIntentPhrase,
  getIntentPhraseMatcher,
} from '../intent/intent-phrase-lexicon.js';
import { detectTextLocale, type SupportedLocale } from '../locale-normalize.js';
import { t } from '../t.js';
import type { IntentResolutionContract } from '../intent/intent-resolution-contract-parser.js';

export const CONVERSATION_TASK_MAX_TASKS = 64;
export const CONVERSATION_TASK_MAX_TITLE = 512;
export const CONVERSATION_TASK_MAX_UPDATES = 64;
export const CONVERSATION_TASK_MAX_TEXT = 8192;
export const CONVERSATION_TASK_MAX_STATE_BYTES = 4 * 1024 * 1024;
export const CONVERSATION_TASK_MAX_EXCERPT = 280;
const MAX_REPLY = 32768;
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const WORK_ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATUSES = ['recorded', 'completed', 'awaiting_input', 'needs_execution'] as const;
const KINDS = [
  'new_request',
  'followup',
  'status',
  'approval',
  'cancellation',
  'chat',
  'clarification',
] as const;
const TARGET_KINDS = ['followup', 'status', 'approval', 'cancellation'] as const;
/** Kinds that only record state; the turn still goes to the conversation runtime. */
const RECORD_ONLY_KINDS = ['new_request', 'followup'] as const;
/** Kinds answered locally, and therefore the only ones that may ask a selection question. */
const CLARIFIABLE_KINDS = ['status', 'approval', 'cancellation'] as const;
export type ConversationTaskKind = (typeof KINDS)[number];
export type ConversationTaskTargetKind = (typeof TARGET_KINDS)[number];
export type ConversationTaskClarifiableKind = (typeof CLARIFIABLE_KINDS)[number];
/**
 * `completed` means the conversation runtime answered the request in place.
 * `needs_execution` marks work the scoped conversation cannot finish; a governed
 * executor may later link it through `workItemId`.
 */
export type ConversationTaskStatus = (typeof STATUSES)[number];
export type ConversationTurnOutcome = 'answered' | 'awaiting_input' | 'needs_execution';
export interface ConversationTaskResult {
  turnId: string;
  excerpt: string;
  at: number;
}
export interface ConversationTaskRecord {
  id: string;
  title: string;
  requestText: string;
  createdAt: number;
  updates: string[];
  state: ConversationTaskStatus;
  result?: ConversationTaskResult;
  workItemId?: string;
}
export interface ConversationTaskState {
  tasks: ConversationTaskRecord[];
  clarification?: {
    kind: ConversationTaskClarifiableKind;
    sourceTurnId: string;
    sourceText: string;
    candidateIds: string[];
  };
}
export interface ConversationTaskDecision {
  kind: ConversationTaskKind;
  taskIds: string[];
  confidence: 'rule' | 'ambiguous' | 'unknown';
  authority: 'none';
  reply?: string;
}
export interface ConversationTaskRoutingResult {
  state: ConversationTaskState;
  decision: ConversationTaskDecision;
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function textValue(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}
function taskResult(value: unknown): value is ConversationTaskResult {
  return (
    record(value) &&
    keys(value, ['turnId', 'excerpt', 'at']) &&
    id(value.turnId) &&
    textValue(value.excerpt, CONVERSATION_TASK_MAX_EXCERPT) &&
    typeof value.at === 'number' &&
    Number.isFinite(value.at) &&
    value.at >= 0
  );
}
function ids(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= CONVERSATION_TASK_MAX_TASKS &&
    value.every(id) &&
    new Set(value).size === value.length
  );
}
/** Missing and malformed values return undefined. The caller initializes absent
 * legacy state but must fail closed when a present field is malformed. */
export function parseConversationTaskState(value: unknown): ConversationTaskState | undefined {
  if (
    !record(value) ||
    !keys(value, ['tasks', 'clarification']) ||
    !Array.isArray(value.tasks) ||
    value.tasks.length > CONVERSATION_TASK_MAX_TASKS
  )
    return undefined;
  const tasks: ConversationTaskRecord[] = [];
  let encodedBytes = Buffer.byteLength('{"tasks":[]}');
  for (const candidate of value.tasks) {
    if (
      !record(candidate) ||
      !keys(candidate, [
        'id',
        'title',
        'requestText',
        'createdAt',
        'updates',
        'state',
        'result',
        'workItemId',
        // Accepted from earlier v2 writers and dropped; it never tracked execution.
        'execution',
      ]) ||
      !id(candidate.id) ||
      !textValue(candidate.title, CONVERSATION_TASK_MAX_TITLE) ||
      !textValue(candidate.requestText, CONVERSATION_TASK_MAX_TEXT) ||
      typeof candidate.createdAt !== 'number' ||
      !Number.isFinite(candidate.createdAt) ||
      candidate.createdAt < 0 ||
      !STATUSES.includes(candidate.state as ConversationTaskStatus) ||
      (candidate.execution !== undefined && candidate.execution !== 'not_started') ||
      (candidate.result !== undefined && !taskResult(candidate.result)) ||
      (candidate.state === 'completed' && candidate.result === undefined) ||
      (candidate.workItemId !== undefined &&
        (typeof candidate.workItemId !== 'string' ||
          !WORK_ITEM_ID_PATTERN.test(candidate.workItemId))) ||
      !Array.isArray(candidate.updates) ||
      candidate.updates.length > CONVERSATION_TASK_MAX_UPDATES ||
      !candidate.updates.every((update) => textValue(update, CONVERSATION_TASK_MAX_TEXT))
    )
      return undefined;
    encodedBytes += Buffer.byteLength(JSON.stringify(candidate)) + (tasks.length ? 1 : 0);
    if (encodedBytes > CONVERSATION_TASK_MAX_STATE_BYTES) return undefined;
    const result = candidate.result as ConversationTaskResult | undefined;
    tasks.push({
      id: candidate.id,
      title: candidate.title,
      requestText: candidate.requestText,
      createdAt: candidate.createdAt,
      updates: [...candidate.updates] as string[],
      state: candidate.state as ConversationTaskStatus,
      ...(result
        ? { result: { turnId: result.turnId, excerpt: result.excerpt, at: result.at } }
        : {}),
      ...(typeof candidate.workItemId === 'string' ? { workItemId: candidate.workItemId } : {}),
    });
  }
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) return undefined;
  if (value.clarification === undefined) return { tasks };
  const pending = value.clarification;
  if (
    !record(pending) ||
    !keys(pending, ['kind', 'sourceTurnId', 'sourceText', 'candidateIds']) ||
    ![...CLARIFIABLE_KINDS, 'followup'].includes(pending.kind as ConversationTaskClarifiableKind) ||
    !id(pending.sourceTurnId) ||
    !textValue(pending.sourceText, CONVERSATION_TASK_MAX_TEXT) ||
    !ids(pending.candidateIds) ||
    pending.candidateIds.length === 0 ||
    pending.candidateIds.some((candidateId) => !tasks.some((task) => task.id === candidateId))
  )
    return undefined;
  // Earlier v2 writers asked follow-up selections. Discard them rather than replaying amendments.
  if (pending.kind === 'followup') return { tasks };
  encodedBytes += Buffer.byteLength(JSON.stringify(pending)) + ',"clarification":'.length;
  if (encodedBytes > CONVERSATION_TASK_MAX_STATE_BYTES) return undefined;
  return {
    tasks,
    clarification: {
      kind: pending.kind as ConversationTaskClarifiableKind,
      sourceTurnId: pending.sourceTurnId,
      sourceText: pending.sourceText,
      candidateIds: [...pending.candidateIds],
    },
  };
}
/** Stored decisions are inert. No executable approval/control metadata is accepted. */
export function parseConversationTaskDecision(
  value: unknown
): ConversationTaskDecision | undefined {
  if (
    !record(value) ||
    !keys(value, ['kind', 'taskIds', 'confidence', 'authority', 'reply']) ||
    !KINDS.includes(value.kind as ConversationTaskKind) ||
    !ids(value.taskIds) ||
    !['rule', 'ambiguous', 'unknown'].includes(String(value.confidence)) ||
    value.authority !== 'none' ||
    (value.reply !== undefined && !textValue(value.reply, MAX_REPLY))
  )
    return undefined;
  if (value.kind === 'chat') {
    if (value.taskIds.length !== 0 || value.reply !== undefined || value.confidence !== 'unknown')
      return undefined;
  } else if (RECORD_ONLY_KINDS.includes(value.kind as (typeof RECORD_ONLY_KINDS)[number])) {
    // Earlier v2 reply receipts and opt-in queued acknowledgements are display-only.
    // Their presence never grants execution or resumes a legacy request.
  } else if (!textValue(value.reply, MAX_REPLY)) return undefined;
  if (value.kind !== 'chat' && value.kind !== 'clarification' && value.taskIds.length !== 1)
    return undefined;
  if (value.kind === 'clarification' && value.confidence !== 'ambiguous') return undefined;
  if (value.kind !== 'clarification' && value.kind !== 'chat' && value.confidence !== 'rule')
    return undefined;
  return {
    kind: value.kind as ConversationTaskKind,
    taskIds: [...value.taskIds],
    confidence: value.confidence as ConversationTaskDecision['confidence'],
    authority: 'none',
    ...(typeof value.reply === 'string' ? { reply: value.reply } : {}),
  };
}
function normalized(text: string): string {
  return text
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[.!?\u3002\uff01\uff1f]+$/u, '')
    .trim();
}
function match(text: string, concept: string): boolean {
  return matchesIntentPhrase(text, 'conversation_task.' + concept);
}
function selectionOrdinal(text: string): number {
  const captured = captureIntentPhrase(text.trim(), 'conversation_task.ordinal');
  return captured
    ? Number(captured)
    : match(text, 'first')
      ? 1
      : match(text, 'second')
        ? 2
        : match(text, 'third')
          ? 3
          : 0;
}
function exactSelection(
  text: string,
  candidates: ConversationTaskRecord[]
): ConversationTaskRecord[] {
  const query = normalized(text);
  const explicit = candidates.filter(
    (task) => query === normalized(task.title) || query === task.id
  );
  if (explicit.length) return explicit;
  const ordinal = selectionOrdinal(text);
  return Number.isInteger(ordinal) && ordinal > 0 && ordinal <= candidates.length
    ? [candidates[ordinal - 1]]
    : [];
}
function result(
  state: ConversationTaskState,
  kind: ConversationTaskKind,
  taskIds: string[],
  reply?: string
): ConversationTaskRoutingResult {
  return {
    state,
    decision: {
      kind,
      taskIds,
      authority: 'none',
      confidence: kind === 'chat' ? 'unknown' : kind === 'clarification' ? 'ambiguous' : 'rule',
      ...(reply ? { reply } : {}),
    },
  };
}
function statusReply(task: ConversationTaskRecord, locale?: SupportedLocale): string {
  const key = {
    recorded: 'front_desk:task_status',
    completed: 'front_desk:task_status_completed',
    awaiting_input: 'front_desk:task_status_awaiting_input',
    needs_execution: 'front_desk:task_status_needs_execution',
  } as const;
  return t(key[task.state], { title: task.title, excerpt: task.result?.excerpt ?? '' }, locale);
}
/**
 * How a runtime turn ended, judged only from structured signals. A reply that
 * needs approval, input, or execution beyond the conversation is not an answer.
 */
export function classifyConversationTurnOutcome(conversation: {
  intentResolution?: Pick<IntentResolutionContract, 'authority_level' | 'resolution_shape'>;
  missionProposals?: readonly unknown[];
  approvalRequests?: readonly unknown[];
}): ConversationTurnOutcome {
  const contract = conversation.intentResolution;
  if (contract?.authority_level === 'human_clarification_required') return 'awaiting_input';
  if (
    contract?.authority_level === 'approval_required' ||
    (contract !== undefined && contract.resolution_shape !== 'direct_answer') ||
    (conversation.missionProposals?.length ?? 0) > 0 ||
    (conversation.approvalRequests?.length ?? 0) > 0
  )
    return 'needs_execution';
  return 'answered';
}
/**
 * Applies a completed runtime turn to the request it recorded or amended.
 * Returns the input unchanged when the outcome would exceed the state bounds.
 */
export function applyConversationTurnOutcome(
  input: ConversationTaskState,
  taskId: string,
  outcome: ConversationTurnOutcome,
  turnId: string,
  reply: string,
  at: number
): ConversationTaskState {
  const state = parseConversationTaskState(input);
  if (!state) throw new Error('[CONVERSATION_TASK_INPUT_INVALID]');
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task) return state;
  if (outcome === 'answered') {
    const excerpt = reply.trim().slice(0, CONVERSATION_TASK_MAX_EXCERPT);
    if (!excerpt) return state;
    task.state = 'completed';
    task.result = { turnId, excerpt, at };
  } else {
    task.state = outcome;
  }
  return parseConversationTaskState(state) ?? parseConversationTaskState(input)!;
}
/** Pure state transition except governed read-only phrase/copy catalogs. Persist
 * state and decision atomically with the turn reservation before any model call. */
export function routeConversationTaskTurn(
  input: ConversationTaskState,
  text: string,
  turnId: string,
  at: number,
  locale?: SupportedLocale
): ConversationTaskRoutingResult {
  const state = parseConversationTaskState(input);
  if (
    !state ||
    !textValue(text, CONVERSATION_TASK_MAX_TEXT) ||
    !id(turnId) ||
    !Number.isFinite(at) ||
    at < 0
  )
    throw new Error('[CONVERSATION_TASK_INPUT_INVALID]');
  const replyLocale = locale ?? detectTextLocale(text) ?? undefined;
  const originalState = structuredClone(state);
  // Record-only and unmatched turns return no reply, so the existing scoped
  // conversation runtime still answers them. Over-budget growth is not recorded.
  const chat = () => {
    delete originalState.clarification;
    return result(originalState, 'chat', []);
  };
  const finish = (
    kind: ConversationTaskKind,
    taskIds: string[],
    reply?: string
  ): ConversationTaskRoutingResult => {
    if (!parseConversationTaskState(state)) {
      if (reply === undefined) return chat();
      return result(
        originalState,
        'clarification',
        [],
        t('front_desk:task_capacity', undefined, replyLocale)
      );
    }
    return result(state, kind, taskIds, reply);
  };
  const answer = (kind: ConversationTaskClarifiableKind, task: ConversationTaskRecord) => {
    delete state.clarification;
    if (kind === 'status') return finish(kind, [task.id], statusReply(task, replyLocale));
    const key = {
      approval: 'front_desk:task_approval',
      cancellation: 'front_desk:task_cancellation',
    } as const;
    return finish(kind, [task.id], t(key[kind], { title: task.title }, replyLocale));
  };
  if (state.clarification) {
    const pending = state.clarification;
    const candidates = pending.candidateIds.map((candidateId) =>
      state.tasks.find((task) => task.id === candidateId)!
    );
    const selected = exactSelection(text, candidates);
    if (selected.length === 1) return answer(pending.kind, selected[0]);
    if (selected.length > 1 || match(text, 'vague_confirmation') || selectionOrdinal(text) > 0)
      return finish(
        'clarification',
        pending.candidateIds,
        t('front_desk:task_no_match', undefined, replyLocale)
      );
    // A different message supersedes the old selection question, including
    // refusal/capacity paths. Rollback must not resurrect that question.
    delete state.clarification;
    delete originalState.clarification;
  }
  const namedHint = captureIntentPhrase(text, 'conversation_task.named_reference');
  const knownNamed =
    namedHint !== undefined &&
    state.tasks.some(
      (task) =>
        normalized(task.title) === normalized(namedHint) ||
        normalized(captureIntentPhrase(task.title, 'conversation_task.task_topic') || '') ===
          normalized(namedHint)
    );
  const signals = [
    ...TARGET_KINDS.filter(
      (kind) =>
        match(text, kind) || (kind === 'status' && knownNamed && match(text, 'status_question'))
    ),
    ...(match(text, 'new_request') ? ['new_request' as const] : []),
  ];
  const newPattern = getIntentPhraseMatcher().regExp('conversation_task.new_request');
  const newMatches = text.matchAll(new RegExp(newPattern.source, newPattern.flags + 'g'));
  const multipleNewRequests = !newMatches.next().done && !newMatches.next().done;
  // Combined clauses are left whole to the conversation runtime rather than
  // half-recorded or answered locally.
  if (signals.length !== 1 || multipleNewRequests || match(text, 'mixed')) return chat();
  const kind = signals[0];
  if (kind === 'new_request') {
    if (state.tasks.length >= CONVERSATION_TASK_MAX_TASKS) return chat();
    if (state.tasks.some((task) => task.id === turnId))
      throw new Error('[CONVERSATION_TASK_DUPLICATE_TURN]');
    const title = (captureIntentPhrase(text, 'conversation_task.title') || text)
      .trim()
      .slice(0, CONVERSATION_TASK_MAX_TITLE);
    state.tasks.push({
      id: turnId,
      title,
      requestText: text,
      createdAt: at,
      updates: [],
      state: 'recorded',
    });
    delete state.clarification;
    return finish(kind, [turnId]);
  }
  const query = normalized(text);
  // Quoted amendment content is not a task reference. Only explicit named
  // target grammar may select a quoted title.
  const quoted =
    namedHint === undefined
      ? undefined
      : captureIntentPhrase(namedHint, 'conversation_task.quoted_reference');
  const mentionedIds: string[] =
    query.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g) || [];
  if (
    mentionedIds.some((mentioned) => !state.tasks.some((task) => task.id === mentioned)) ||
    (quoted !== undefined &&
      !state.tasks.some((task) => normalized(task.title) === normalized(quoted)))
  )
    return chat();
  const namedQuery =
    namedHint === undefined ||
    match(namedHint, 'deictic') ||
    (kind === 'followup' && match(namedHint, 'amendment_field'))
      ? undefined
      : normalized(quoted ?? namedHint);
  const explicit = state.tasks.filter((task) =>
    namedQuery !== undefined
      ? task.id === namedQuery ||
        normalized(task.title) === namedQuery ||
        normalized(captureIntentPhrase(task.title, 'conversation_task.task_topic') || '') ===
          namedQuery
      : mentionedIds.includes(task.id)
  );
  if (namedQuery !== undefined && explicit.length === 0) return chat();
  if (kind === 'followup') {
    // Implicit amendments ("make it shorter") usually refer to the latest reply,
    // so only an explicitly named, unique request receives the note.
    const target = explicit.length === 1 ? explicit[0] : undefined;
    if (!target || target.updates.length >= CONVERSATION_TASK_MAX_UPDATES) return chat();
    target.updates.push(text);
    delete state.clarification;
    return finish(kind, [target.id]);
  }
  // Bare confirmations and cancellations may answer the runtime's own preview,
  // so approval/cancellation never fall back to an implicit target.
  const implicitTarget =
    kind === 'status' &&
    (match(text, 'implicit_reference') || (namedHint !== undefined && match(namedHint, 'deictic')));
  const candidates = explicit.length ? explicit : implicitTarget ? state.tasks : [];
  if (candidates.length === 0) return chat();
  if (candidates.length === 1) return answer(kind, candidates[0]);
  state.clarification = {
    kind,
    sourceTurnId: turnId,
    sourceText: text,
    candidateIds: candidates.map((task) => task.id),
  };
  return finish(
    'clarification',
    state.clarification.candidateIds,
    t(
      'front_desk:task_choose',
      {
        choices: candidates
          .map((task, index) => String(index + 1) + '. ' + task.title.slice(0, 120))
          .join('\n'),
      },
      replyLocale
    )
  );
}
