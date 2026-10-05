/**
 * Bounded front-desk intake routing. Records requests and resolves references,
 * without starting, verifying, approving, cancelling, or steering execution.
 * Callers supply server-owned state and already-redacted display text.
 */
import {
  captureIntentPhrase,
  matchesIntentPhrase,
  getIntentPhraseMatcher,
} from '../intent/intent-phrase-lexicon.js';
import { detectTextLocale, type SupportedLocale } from '../locale-normalize.js';
import { t } from '../t.js';

export const CONVERSATION_TASK_MAX_TASKS = 64;
export const CONVERSATION_TASK_MAX_TITLE = 512;
export const CONVERSATION_TASK_MAX_UPDATES = 64;
export const CONVERSATION_TASK_MAX_TEXT = 8192;
export const CONVERSATION_TASK_MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_REPLY = 32768;
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
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
export type ConversationTaskKind = (typeof KINDS)[number];
export type ConversationTaskTargetKind = (typeof TARGET_KINDS)[number];
export interface ConversationTaskRecord {
  id: string;
  title: string;
  requestText: string;
  createdAt: number;
  updates: string[];
  state: 'recorded';
  execution: 'not_started';
}
export interface ConversationTaskState {
  tasks: ConversationTaskRecord[];
  clarification?: {
    kind: ConversationTaskTargetKind;
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
        'execution',
      ]) ||
      !id(candidate.id) ||
      !textValue(candidate.title, CONVERSATION_TASK_MAX_TITLE) ||
      !textValue(candidate.requestText, CONVERSATION_TASK_MAX_TEXT) ||
      typeof candidate.createdAt !== 'number' ||
      !Number.isFinite(candidate.createdAt) ||
      candidate.createdAt < 0 ||
      candidate.state !== 'recorded' ||
      candidate.execution !== 'not_started' ||
      !Array.isArray(candidate.updates) ||
      candidate.updates.length > CONVERSATION_TASK_MAX_UPDATES ||
      !candidate.updates.every((update) => textValue(update, CONVERSATION_TASK_MAX_TEXT))
    )
      return undefined;
    encodedBytes += Buffer.byteLength(JSON.stringify(candidate)) + (tasks.length ? 1 : 0);
    if (encodedBytes > CONVERSATION_TASK_MAX_STATE_BYTES) return undefined;
    tasks.push({
      id: candidate.id,
      title: candidate.title,
      requestText: candidate.requestText,
      createdAt: candidate.createdAt,
      updates: [...candidate.updates] as string[],
      state: 'recorded',
      execution: 'not_started',
    });
  }
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) return undefined;
  if (value.clarification === undefined) return { tasks };
  const pending = value.clarification;
  if (
    !record(pending) ||
    !keys(pending, ['kind', 'sourceTurnId', 'sourceText', 'candidateIds']) ||
    !TARGET_KINDS.includes(pending.kind as ConversationTaskTargetKind) ||
    !id(pending.sourceTurnId) ||
    !textValue(pending.sourceText, CONVERSATION_TASK_MAX_TEXT) ||
    !ids(pending.candidateIds) ||
    pending.candidateIds.length === 0 ||
    pending.candidateIds.some((candidateId) => !tasks.some((task) => task.id === candidateId))
  )
    return undefined;
  encodedBytes += Buffer.byteLength(JSON.stringify(pending)) + ',"clarification":'.length;
  if (encodedBytes > CONVERSATION_TASK_MAX_STATE_BYTES) return undefined;
  return {
    tasks,
    clarification: {
      kind: pending.kind as ConversationTaskTargetKind,
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
  const finish = (
    kind: ConversationTaskKind,
    taskIds: string[],
    reply?: string
  ): ConversationTaskRoutingResult => {
    if (!parseConversationTaskState(state))
      return result(
        originalState,
        'clarification',
        [],
        t('front_desk:task_capacity', undefined, replyLocale)
      );
    return result(state, kind, taskIds, reply);
  };
  const clarify = (
    key: 'task_mixed' | 'task_capacity' | 'task_no_match' | 'task_update_capacity',
    taskIds: string[] = []
  ) =>
    finish(
      'clarification',
      taskIds,
      t(('front_desk:' + key) as Parameters<typeof t>[0], undefined, replyLocale)
    );
  const bind = (
    kind: ConversationTaskTargetKind,
    task: ConversationTaskRecord,
    sourceText: string
  ) => {
    if (kind === 'followup') {
      if (task.updates.length >= CONVERSATION_TASK_MAX_UPDATES)
        return clarify('task_update_capacity', [task.id]);
      task.updates.push(sourceText);
    }
    delete state.clarification;
    const key = {
      status: 'front_desk:task_status',
      followup: 'front_desk:task_followup',
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
    if (selected.length === 1) return bind(pending.kind, selected[0], pending.sourceText);
    if (selected.length > 1 || match(text, 'vague_confirmation') || selectionOrdinal(text) > 0)
      return clarify('task_no_match', pending.candidateIds);
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
  if (signals.length > 1 || multipleNewRequests || (signals.length > 0 && match(text, 'mixed')))
    return clarify('task_mixed');
  if (signals.length === 0) {
    if (selectionOrdinal(text) > 0) return clarify('task_no_match');
    delete state.clarification;
    return finish('chat', []);
  }
  const kind = signals[0];
  if (kind === 'new_request') {
    if (state.tasks.length >= CONVERSATION_TASK_MAX_TASKS) return clarify('task_capacity');
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
      execution: 'not_started',
    });
    delete state.clarification;
    return finish(kind, [turnId], t('front_desk:task_recorded', { title }, replyLocale));
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
    return clarify('task_no_match');
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
  if (namedQuery !== undefined && explicit.length === 0) return clarify('task_no_match');
  const implicitTarget =
    match(text, 'implicit_reference') || (namedHint !== undefined && match(namedHint, 'deictic'));
  if (explicit.length === 0 && !implicitTarget) return clarify('task_no_match');
  const candidates = explicit.length ? explicit : state.tasks;
  if (candidates.length === 1) return bind(kind, candidates[0], text);
  if (candidates.length === 0) return clarify('task_no_match');
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
