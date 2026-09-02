import {
  appendReminder,
  listActionItems,
  listOperatorSelfPending,
  listOthersPending,
  nextActionItemId,
  recordActionItem,
  updateActionItemStatus,
  type ActionItem,
  type ActionItemAssignee,
  type ActionItemAssigneeKind,
  type ActionItemModality,
  type ActionItemProvenance,
  type ActionItemReviewState,
} from '@agent/core/action-item-store';
import {
  enqueueSlackOutboxMessage,
  listSlackOutboxMessages,
} from '@agent/core/surface-coordination-store';
import { delegateBestOf, getReasoningBackend } from '@agent/core/reasoning-backend';
import { getVoiceBridge } from '@agent/core/voice-bridge';
import { loadMeetingFacilitatorPolicy } from '@agent/core/meeting-facilitator-policy';
import { logger } from '@agent/core/core';
import { matchRestrictedAction } from '@agent/core/restricted-action-policy';
import { listMissionSummaries } from '@agent/core/mission-read-model';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeWriteFile,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import * as path from 'node:path';
import { z } from 'zod';
import { getWorkItem } from '@agent/core/work-coordination';
import { delegateWorkItemWithReasoningBackend } from '@agent/core/reasoning-backend-execution-adapter';
import { getRegisteredEnvText, isRecord, nowIso, parseSafeJsonInput } from '@agent/core/foundation';
import type { MeetingFacilitatorPolicy } from '@agent/core/meeting-facilitator-policy';

function writeJSON(rel: string, data: unknown): string {
  const abs = assertSafeRepositoryPath(pathResolver.rootResolve(rel), { allowMissingLeaf: true });
  const dir = path.dirname(abs);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(abs, JSON.stringify(data, null, 2));
  return abs;
}

function deriveReasoningMode(backendName: string, synthetic = false): 'placeholder' | 'model' {
  if (synthetic) return 'placeholder';
  const normalized = String(backendName || '').toLowerCase();
  return normalized === 'stub' || normalized.endsWith('-stub') ? 'placeholder' : 'model';
}

export async function delegateMeetingReasoning(input: {
  backend: ReturnType<typeof getReasoningBackend>;
  prompt: string;
  context: string;
  mission_id?: string;
  work_item_id?: string;
  task_id: string;
}): Promise<string> {
  if (!input.work_item_id) {
    if (input.mission_id) {
      throw new Error(
        '[MEETING_WORK_ITEM_REQUIRED] mission-scoped meeting reasoning requires a canonical WorkItem'
      );
    }
    return input.backend.delegateTask(input.prompt, input.context);
  }
  const workItem = getWorkItem(input.work_item_id);
  if (!workItem) throw new Error(`[WORK_ITEM_NOT_FOUND] ${input.work_item_id}`);
  const context = workItem.context;
  const missionId = context?.mission_id ?? input.mission_id;
  const tenantId = context?.tenant_slug;
  if (!tenantId || !missionId) {
    throw new Error(
      '[MEETING_SCOPE_REQUIRED] canonical WorkItem tenant and mission scope are required'
    );
  }
  if (input.mission_id && context?.mission_id && input.mission_id !== context.mission_id) {
    throw new Error('[MEETING_SCOPE_MISMATCH] mission scope does not match the canonical WorkItem');
  }
  const receipt = await delegateWorkItemWithReasoningBackend(input.backend, {
    work_item_id: input.work_item_id,
    task_id: input.task_id,
    mission_id: missionId,
    instruction: input.prompt,
    context_refs: [input.context],
    idempotency_key: `meeting-reasoning:${input.work_item_id}:${input.task_id}`,
    security_scope: {
      tenant_id: tenantId,
      organization_id: context.organization_id,
      project_id: context.project_id,
      mission_id: missionId,
      read_tiers: ['public'],
      write_tier: 'public',
      purpose: 'meeting intelligence delegation',
    },
  });
  if (receipt.status !== 'succeeded') throw new Error(receipt.error ?? 'meeting reasoning blocked');
  return receipt.output ?? '';
}

export async function conduct1on1(input: {
  counterparty_ref: string;
  proposal_draft_ref: string;
  structure: string[];
  output_path: string;
}): Promise<{ written_to: string; reasoning_mode: 'placeholder' | 'model' }> {
  const bridge = getVoiceBridge();
  const result = await bridge.runOneOnOneSession({
    counterpartyRef: input.counterparty_ref,
    proposalDraftRef: input.proposal_draft_ref,
    structure: input.structure,
    outputPath: input.output_path,
  });
  const reasoningMode = deriveReasoningMode(bridge.name, Boolean(result._synthetic));
  writeJSON(input.output_path, {
    person_slug: result.person_slug,
    visited_at: result.visited_at,
    structure: input.structure,
    transcript: result.transcript,
    stance: result.stance,
    conditions: result.conditions,
    dissent_signals: result.dissent_signals,
    engine_id: result.engine_id ?? null,
    generated_by: bridge.name,
    reasoning_mode: reasoningMode,
    ...(result._synthetic ? { _synthetic: true } : {}),
  });
  return { written_to: input.output_path, reasoning_mode: reasoningMode };
}
// ---------------------------------------------------------------------------
// Meeting facilitation ops (G6 / new use case)
//
// extract_action_items / generate_facilitation_script / generate_reminder_message
// drive the AI-runs-meetings flow. Ephemeral calls use backend.delegateTask;
// mission-scoped calls require a canonical WorkItem and use the governed port.
// ---------------------------------------------------------------------------

function extractFirstJsonBlock(text: string): unknown {
  const trimmed = text.trim();
  // Extract JSON inside a code fence first.
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return parseSafeJsonInput(fenced[1], 'meeting model response');
  // Fallback: locate the first top-level {...} or [...].
  const start = trimmed.search(/[\[{]/);
  if (start === -1) throw new Error('no JSON block in delegateTask response');
  const open = trimmed[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    if (trimmed[i] === open) depth += 1;
    else if (trimmed[i] === close) {
      depth -= 1;
      if (depth === 0)
        return parseSafeJsonInput(trimmed.slice(start, i + 1), 'meeting model response');
    }
  }
  throw new Error('unbalanced JSON block in delegateTask response');
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : undefined;
}

export function parseMeetingModelObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('meeting model response must be a JSON object');
  return value;
}

export function parseMeetingModelObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error('meeting model response must be a JSON array');
  return value.map((entry, index) => {
    try {
      return parseMeetingModelObject(entry);
    } catch {
      throw new Error(`meeting model response item ${index} must be a JSON object`);
    }
  });
}

const ACTION_ITEM_ASSIGNEE_KINDS: readonly ActionItemAssigneeKind[] = [
  'operator_self',
  'team_member',
  'external',
  'unassigned',
];
const ACTION_ITEM_PRIORITIES = ['must', 'should', 'could', 'wont'] as const;
const FACILITATION_ACTIONS = ['continue_listen', 'transition_topic', 'wrap_up', 'pause'] as const;

export async function extractActionItemsOp(input: {
  mission_id: string;
  work_item_id?: string;
  transcript: string;
  attendees?: Array<{
    name: string;
    person_slug?: string;
    channel_handle?: string;
    manager_handle?: string;
  }>;
  operator_label?: string;
  default_assignee_label?: string;
  language?: string;
  default_max_reminders?: number;
  /**
   * Ops-3: when true, every extracted item is recorded with
   * `partial_state=true` so it fail-closes self-execution / tracking
   * until cleared. Set this when the upstream listen result reported
   * `partial_state` (bridge timeout, dropped capture, empty transcript).
   */
  partial_state?: boolean;
  partial_reason?: string;
  /**
   * Compliance-2: when true, run each item through the restricted-action-kinds
   * policy and tag matches with `restricted` + `restriction_rule_id`. Defaults
   * to true; supply false only for closed-loop tests.
   */
  enforce_restricted_actions?: boolean;
}): Promise<{
  items: ActionItem[];
  written_count: number;
  pending_review_count: number;
  partial_count: number;
  restricted_count: number;
}> {
  const backend = getReasoningBackend();
  const operatorLabel = input.operator_label ?? 'Operator';
  const attendees = input.attendees ?? [];
  const attendeesBlock = attendees.length
    ? attendees
        .map(
          (a) =>
            `  - ${a.name}${a.person_slug ? ` (slug=${a.person_slug})` : ''}${
              a.channel_handle ? ` (channel=${a.channel_handle})` : ''
            }`
        )
        .join('\n')
    : '  (none provided)';
  const language = input.language ?? 'auto';
  const defaultMaxReminders = input.default_max_reminders ?? 5;
  const prompt = [
    'You analyze a meeting transcript and produce a JSON array of action items.',
    '',
    'Output rules:',
    '- Output ONLY a JSON array. No prose. No code fence.',
    '- Each item: { "title": str (≤120 chars, imperative), "summary": str?, "assignee_label": str, "assignee_kind": "operator_self"|"team_member"|"external"|"unassigned", "priority": "must"|"should"|"could"|"wont", "due_at_iso": str?, "modality": "declarative"|"conditional"|"hypothetical"|"rhetorical"|"humor", "speaker_label": str, "transcript_excerpt": str (≤240 chars, verbatim), "transcript_offset_lines": [int] }',
    '',
    `- assignee_kind = "operator_self" when the assignee matches "${operatorLabel}".`,
    '- assignee_kind = "team_member" when the assignee is in the attendees list (not the operator).',
    '- assignee_kind = "external" when the assignee is named but not in the attendee list.',
    '- assignee_kind = "unassigned" when the action item has no clear owner.',
    '',
    'CRITICAL — modality classification (audit-load-bearing):',
    '- "declarative"  : a clear commitment ("I will send X by Friday").',
    '- "conditional"  : depends on a precondition not yet met ("if budget approves, then …").',
    '- "hypothetical" : exploratory or thought-experiment ("we could try …", "what if we …").',
    '- "rhetorical"   : framed as a question but not requesting action ("should we even do this?").',
    '- "humor"        : a joke / sarcasm / reductio ad absurdum ("let\\u0027s just delete prod").',
    'When modality != "declarative", the item lands in pending_speaker_review and will NOT be auto-executed or auto-tracked. Be conservative: if uncertain whether a sentence is a real commitment, label "conditional" or "hypothetical" rather than "declarative".',
    '',
    '- speaker_label: who actually uttered the words (one of the attendees, the operator, or "unknown").',
    '- transcript_excerpt: a verbatim ≤ 240-char excerpt of the source line(s).',
    '- transcript_offset_lines: 1-based line numbers in the transcript referenced by this item.',
    '',
    '- Capture imperatives, owners, and any deadlines; do not invent owners or deadlines that are not in the transcript.',
    '',
    'Attendees:',
    attendeesBlock,
    '',
    'Transcript:',
    input.transcript,
    '',
    `Language hint: ${language}.`,
  ].join('\n');
  const extractedAt = nowIso();
  const raw = await delegateMeetingReasoning({
    backend,
    prompt,
    context: `mission=${input.mission_id}`,
    mission_id: input.mission_id,
    work_item_id: input.work_item_id,
    task_id: 'extract-action-items',
  });
  let parsed: Array<Record<string, unknown>>;
  try {
    parsed = parseMeetingModelObjectArray(extractFirstJsonBlock(raw));
  } catch (err: any) {
    logger.warn(
      `[extract_action_items] parse failed: ${err?.message ?? err}; raw="${raw.slice(0, 200)}"`
    );
    return {
      items: [],
      written_count: 0,
      pending_review_count: 0,
      partial_count: 0,
      restricted_count: 0,
    };
  }

  const operatorTokens = new Set([operatorLabel.toLowerCase(), 'operator', 'self', 'me']);
  const validModalities = new Set([
    'declarative',
    'conditional',
    'hypothetical',
    'rhetorical',
    'humor',
  ]);
  const items: ActionItem[] = [];
  let i = 0;
  let pendingReview = 0;
  let restrictedCount = 0;
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const title = String(entry.title ?? '').trim();
    if (title.length < 5) continue;
    const assigneeLabel =
      String(entry.assignee_label ?? input.default_assignee_label ?? 'unassigned').trim() ||
      'unassigned';
    let kind: ActionItemAssigneeKind =
      parseEnum(entry.assignee_kind, ACTION_ITEM_ASSIGNEE_KINDS) || 'unassigned';
    if (kind === 'unassigned' && operatorTokens.has(assigneeLabel.toLowerCase())) {
      kind = 'operator_self';
    }
    const matchedAttendee = attendees.find(
      (a) => a.name.toLowerCase() === assigneeLabel.toLowerCase()
    );
    if (matchedAttendee && kind !== 'operator_self') {
      kind = 'team_member';
    }
    const assignee: ActionItemAssignee = {
      kind,
      label: assigneeLabel,
      ...(matchedAttendee?.person_slug ? { person_slug: matchedAttendee.person_slug } : {}),
      ...(matchedAttendee?.channel_handle
        ? { channel_handle: matchedAttendee.channel_handle }
        : {}),
    };
    // HR-2 chain-of-command: lift the manager handle off the matched
    // attendee record. The reminder dispatcher CCs this when priority
    // is `must` or when the per-tenant policy demands manager visibility.
    const managerHandle = matchedAttendee?.manager_handle;
    const modality: ActionItemModality = validModalities.has(String(entry.modality))
      ? (entry.modality as ActionItemModality)
      : 'declarative';
    const reviewState: ActionItemReviewState =
      modality === 'declarative' ? 'auto_committed' : 'pending_speaker_review';
    if (reviewState === 'pending_speaker_review') pendingReview += 1;
    const provenance: ActionItemProvenance = {
      ...(typeof entry.speaker_label === 'string' ? { speaker_label: entry.speaker_label } : {}),
      ...(typeof entry.transcript_excerpt === 'string'
        ? { transcript_excerpt: String(entry.transcript_excerpt).slice(0, 240) }
        : {}),
      ...(Array.isArray(entry.transcript_offset_lines)
        ? {
            transcript_offset_lines: entry.transcript_offset_lines
              .map((n: unknown) => Number(n))
              .filter((n: number) => Number.isFinite(n) && n > 0),
          }
        : {}),
      extractor: {
        backend: backend.name,
        model: getRegisteredEnvText('KYBERION_CLAUDE_CLI_MODEL') || 'opus',
        extracted_at: extractedAt,
      },
    };
    i += 1;
    const itemId = nextActionItemId(input.mission_id, `M${i}`);
    // Compliance-2: classify against restricted-action-kinds policy.
    const restrictedHit =
      input.enforce_restricted_actions === false
        ? null
        : matchRestrictedAction({
            title: title.slice(0, 120),
            summary: typeof entry.summary === 'string' ? entry.summary : undefined,
          });
    if (restrictedHit) restrictedCount += 1;
    const summaryParts: string[] = [];
    if (typeof entry.summary === 'string') summaryParts.push(entry.summary);
    if (input.partial_state && input.partial_reason) {
      summaryParts.push(`[partial_state] ${input.partial_reason}`);
    }
    const policy: Record<string, unknown> = {};
    if (input.partial_state) policy.partial_state = true;
    if (restrictedHit) {
      policy.restricted = true;
      policy.restriction_rule_id = restrictedHit.id;
    }
    if (managerHandle) policy.manager_handle = managerHandle;
    const priority = parseEnum(entry.priority, ACTION_ITEM_PRIORITIES);
    const dueAt = typeof entry.due_at_iso === 'string' ? entry.due_at_iso : undefined;
    const recorded = recordActionItem({
      item_id: itemId,
      mission_id: input.mission_id,
      title: title.slice(0, 120),
      ...(summaryParts.length ? { summary: summaryParts.join('\n') } : {}),
      assignee,
      ...(priority ? { priority } : {}),
      ...(dueAt ? { due_at: dueAt } : {}),
      modality,
      review_state: reviewState,
      provenance,
      max_reminders: defaultMaxReminders,
      ...(Object.keys(policy).length ? { policy } : {}),
    });
    items.push(recorded);
  }
  return {
    items,
    written_count: items.length,
    pending_review_count: pendingReview,
    partial_count: input.partial_state ? items.length : 0,
    restricted_count: restrictedCount,
  };
}

export async function generateFacilitationScriptOp(input: {
  mission_id?: string;
  work_item_id?: string;
  agenda?: string[];
  current_topic?: string;
  recent_transcript_chunk?: string;
  remaining_minutes?: number;
  facilitator_persona_label?: string;
  language?: string;
}): Promise<{
  speech_text: string;
  next_action: 'continue_listen' | 'transition_topic' | 'wrap_up' | 'pause';
}> {
  const backend = getReasoningBackend();
  const persona = input.facilitator_persona_label ?? 'a calm professional facilitator';
  const remaining = input.remaining_minutes ?? 30;
  const agendaBlock =
    (input.agenda ?? []).map((a, i) => `  ${i + 1}. ${a}`).join('\n') || '  (no agenda provided)';
  const language = input.language ?? 'ja';
  const prompt = [
    `You generate the next short facilitation utterance for ${persona} in an online meeting.`,
    'Output ONLY a JSON object: { "speech_text": str (≤ 2 sentences), "next_action": "continue_listen"|"transition_topic"|"wrap_up"|"pause" }',
    'No prose, no code fence.',
    `Language: ${language}. Be concise. Do not name people unless the transcript names them. Do not introduce facts not in the transcript.`,
    '',
    'Agenda:',
    agendaBlock,
    '',
    `Current topic: ${input.current_topic ?? '(unspecified)'}`,
    `Time remaining: ${remaining} minutes.`,
    '',
    'Recent transcript chunk:',
    input.recent_transcript_chunk ?? '(silence so far)',
  ].join('\n');
  const facilitationSchema = z.object({
    speech_text: z.string(),
    next_action: z.enum(['continue_listen', 'transition_topic', 'wrap_up', 'pause']),
  });
  if (input.mission_id && !input.work_item_id) {
    throw new Error(
      '[MEETING_WORK_ITEM_REQUIRED] mission-scoped meeting reasoning requires a canonical WorkItem'
    );
  }
  if (input.work_item_id) {
    const raw = await delegateMeetingReasoning({
      backend,
      prompt,
      context: 'meeting-facilitation',
      mission_id: input.mission_id,
      work_item_id: input.work_item_id,
      task_id: 'facilitation-script',
    });
    try {
      const parsed = parseMeetingModelObject(extractFirstJsonBlock(raw));
      return {
        speech_text: typeof parsed.speech_text === 'string' ? parsed.speech_text : '',
        next_action: parseEnum(parsed.next_action, FACILITATION_ACTIONS) || 'continue_listen',
      };
    } catch (parseErr: any) {
      logger.warn(`[generate_facilitation_script] parse failed: ${parseErr?.message ?? parseErr}`);
      return { speech_text: '', next_action: 'continue_listen' };
    }
  }
  try {
    const result = await delegateBestOf(backend, prompt, facilitationSchema, {
      context: 'meeting-facilitation',
      candidateCount: 2,
      judgeInstructions:
        'Prefer the candidate that is concise, natural in the requested language, and most likely to help the meeting advance without adding unsupported facts.',
    });
    return result.winner;
  } catch (err: any) {
    logger.warn(`[generate_facilitation_script] best-of failed: ${err?.message ?? err}`);
    const raw = await delegateMeetingReasoning({
      backend,
      prompt,
      context: 'meeting-facilitation',
      mission_id: input.mission_id,
      work_item_id: input.work_item_id,
      task_id: 'facilitation-script',
    });
    try {
      const parsed = parseMeetingModelObject(extractFirstJsonBlock(raw));
      const speech = typeof parsed.speech_text === 'string' ? parsed.speech_text : '';
      const next = parseEnum(parsed.next_action, FACILITATION_ACTIONS) || 'continue_listen';
      return { speech_text: speech, next_action: next };
    } catch (parseErr: any) {
      logger.warn(`[generate_facilitation_script] parse failed: ${parseErr?.message ?? parseErr}`);
      return { speech_text: '', next_action: 'continue_listen' };
    }
  }
}

/**
 * Compliance-2 approval gate.
 *
 * Partition pending items into `allowed` (free to proceed) and
 * `blocked` (restricted + not approved + no sudo). The caller marks
 * blocked items as `blocked` in the store and proceeds to dispatch
 * the rest. Pure function so the dispatch loop is testable.
 */
export function applyRestrictedActionGate(
  items: ActionItem[],
  opts: { approved_item_ids: ReadonlySet<string>; sudo_override: boolean }
): {
  allowed: ActionItem[];
  blocked: Array<{
    item: ActionItem;
    rule_id?: string;
    reason: string;
  }>;
} {
  const allowed: ActionItem[] = [];
  const blocked: Array<{ item: ActionItem; rule_id?: string; reason: string }> = [];
  for (const item of items) {
    if (
      item.policy?.restricted &&
      !opts.sudo_override &&
      !opts.approved_item_ids.has(item.item_id)
    ) {
      const ruleId = item.policy?.restriction_rule_id;
      blocked.push({
        item,
        ...(ruleId ? { rule_id: ruleId } : {}),
        reason: `restricted-action-kinds gate: rule=${ruleId ?? 'unknown'}; set KYBERION_RESTRICTED_APPROVED_ITEMS or KYBERION_SUDO to release`,
      });
      continue;
    }
    allowed.push(item);
  }
  return { allowed, blocked };
}

/**
 * Execute every operator_self pending item: gate restricted items,
 * then for each allowed item, mark in_progress, delegate the plan to
 * the reasoning backend, and transition to completed (or blocked on
 * failure). Returns a structured report; mutates the action-item
 * store via `updateActionItemStatus`.
 */
export async function executeSelfActionItemsOp(input: {
  mission_id: string;
  work_item_id?: string;
  language?: string;
  policy?: MeetingFacilitatorPolicy;
}): Promise<{
  mission_id: string;
  dispatched: Array<{ item_id: string; title: string; plan: string }>;
  skipped_restricted: Array<{ item_id: string; title: string; restriction_rule_id?: string }>;
  generated_at: string;
}> {
  const language = input.language ?? 'ja';
  const policy = input.policy ?? loadMeetingFacilitatorPolicy();
  const pending = listOperatorSelfPending(input.mission_id);
  const { allowed, blocked } = applyRestrictedActionGate(pending, {
    approved_item_ids: policy.restricted_approved_item_ids,
    sudo_override: policy.sudo_override,
  });
  const skippedRestricted = blocked.map(({ item, rule_id, reason }) => {
    updateActionItemStatus({
      mission_id: input.mission_id,
      item_id: item.item_id,
      status: 'blocked',
      blocked_reason: reason,
      execution: { executed_via: 'agent_delegate', result_summary: reason },
    });
    return {
      item_id: item.item_id,
      title: item.title,
      ...(rule_id ? { restriction_rule_id: rule_id } : {}),
    };
  });

  const backend = getReasoningBackend();
  const dispatched: Array<{ item_id: string; title: string; plan: string }> = [];
  for (const item of allowed) {
    updateActionItemStatus({
      mission_id: input.mission_id,
      item_id: item.item_id,
      status: 'in_progress',
    });
    let plan = '';
    try {
      plan = await delegateMeetingReasoning({
        backend,
        prompt: [
          `You are dispatching an action item to the operator. Output ONLY a JSON object: { "plan": str (≤ 5 sentences), "completion_summary": str (≤ 3 sentences) }.`,
          `No prose, no code fence. Language: ${language}.`,
          `Action item title: "${item.title}".`,
          item.summary ? `Summary: ${item.summary}` : '',
          item.due_at ? `Due: ${item.due_at}.` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        context: `self-exec:${item.item_id}`,
        mission_id: input.mission_id,
        work_item_id: input.work_item_id,
        task_id: `self-exec-${item.item_id}`,
      });
      let summary = '';
      try {
        const parsed = parseMeetingModelObject(extractFirstJsonBlock(plan));
        if (typeof parsed.completion_summary === 'string') summary = parsed.completion_summary;
        if (typeof parsed.plan === 'string') plan = parsed.plan;
      } catch {
        /* keep raw plan */
      }
      updateActionItemStatus({
        mission_id: input.mission_id,
        item_id: item.item_id,
        status: 'completed',
        execution: {
          executed_via: 'agent_delegate',
          execution_ref: `delegateTask:self-exec:${item.item_id}`,
          ...(summary ? { result_summary: summary } : {}),
        },
      });
    } catch (err: any) {
      updateActionItemStatus({
        mission_id: input.mission_id,
        item_id: item.item_id,
        status: 'blocked',
        blocked_reason: `delegateTask failed: ${err?.message ?? err}`,
        execution: {
          executed_via: 'agent_delegate',
          result_summary: `delegateTask failed: ${err?.message ?? err}`,
        },
      });
    }
    dispatched.push({ item_id: item.item_id, title: item.title, plan });
  }
  return {
    mission_id: input.mission_id,
    dispatched,
    skipped_restricted: skippedRestricted,
    generated_at: nowIso(),
  };
}

/**
 * Track every team_member pending item: per-item, generate a reminder
 * message, persist it as a `primary` reminder, and append `cc_manager`
 * reminders for any HR-2 escalation channel returned by
 * `generateReminderMessageOp`. Returns the report; mutates the store.
 */
export async function trackPendingActionItemsOp(input: {
  mission_id: string;
  work_item_id?: string;
  tone?: 'friendly' | 'formal' | 'urgent';
  language?: string;
  max_items?: number;
  policy?: MeetingFacilitatorPolicy;
}): Promise<{
  mission_id: string;
  scanned: number;
  reminded: Array<{
    item_id: string;
    channel: string;
    days_overdue: number;
    cc?: string[];
  }>;
  generated_at: string;
}> {
  const tone = input.tone ?? 'friendly';
  const language = input.language ?? 'ja';
  const maxItems = input.max_items ?? 20;
  const policy = input.policy ?? loadMeetingFacilitatorPolicy();
  const pending = listOthersPending(input.mission_id).slice(0, maxItems);
  const now = new Date();
  const reminded: Array<{
    item_id: string;
    channel: string;
    days_overdue: number;
    cc?: string[];
  }> = [];
  for (const item of pending) {
    const dueAt = item.due_at ? new Date(item.due_at) : null;
    const daysOverdue = dueAt
      ? Math.max(0, Math.floor((now.getTime() - dueAt.getTime()) / (24 * 60 * 60 * 1000)))
      : 0;
    const reminder = await generateReminderMessageOp({
      item,
      days_overdue: daysOverdue,
      tone,
      language,
      policy,
      mission_id: input.mission_id,
      work_item_id: input.work_item_id,
    });
    appendReminder({
      mission_id: input.mission_id,
      item_id: item.item_id,
      reminder: {
        sent_at: now.toISOString(),
        channel: reminder.channel,
        message: reminder.text,
        relationship: 'primary',
      },
    });
    if (reminder.cc && reminder.cc.length) {
      for (const ccChannel of reminder.cc) {
        appendReminder({
          mission_id: input.mission_id,
          item_id: item.item_id,
          reminder: {
            sent_at: now.toISOString(),
            channel: ccChannel,
            message: reminder.text,
            relationship: 'cc_manager',
          },
        });
      }
    }
    reminded.push({
      item_id: item.item_id,
      channel: reminder.channel,
      days_overdue: daysOverdue,
      ...(reminder.cc && reminder.cc.length ? { cc: reminder.cc } : {}),
    });
  }
  return {
    mission_id: input.mission_id,
    scanned: pending.length,
    reminded,
    generated_at: nowIso(),
  };
}

/**
 * HR-3 speaker fairness audit. Aggregates `provenance.speaker_label`
 * across the mission and emits a share-of-voice report. Pure read —
 * does not mutate the store. Defaults the dominance thresholds to
 * the values from the meeting-facilitator outcome simulation; callers
 * can override (per-tenant configurations).
 */
export interface SpeakerFairnessReport {
  mission_id: string;
  total_items: number;
  attributed_items: number;
  unattributed_items: number;
  distribution: Array<{
    speaker: string;
    total: number;
    must: number;
    share_total: number;
    share_must: number;
  }>;
  dominant_speaker: string | null;
  warn: boolean;
  warn_reason: string | null;
  generated_at: string;
}

export function auditSpeakerFairnessOp(input: {
  mission_id: string;
  policy?: MeetingFacilitatorPolicy;
  /** Per-call override; takes precedence over `policy.speaker_fairness_total_threshold`. */
  total_threshold?: number;
  /** Per-call override; takes precedence over `policy.speaker_fairness_must_threshold`. */
  must_threshold?: number;
}): SpeakerFairnessReport {
  const policy = input.policy ?? loadMeetingFacilitatorPolicy();
  const items = listActionItems(input.mission_id);
  const counts: Record<string, { total: number; must: number }> = {};
  let totalAttributed = 0;
  let mustAttributed = 0;
  for (const it of items) {
    const speaker = it.provenance?.speaker_label?.trim();
    if (!speaker) continue;
    if (!counts[speaker]) counts[speaker] = { total: 0, must: 0 };
    counts[speaker].total += 1;
    totalAttributed += 1;
    if (it.priority === 'must') {
      counts[speaker].must += 1;
      mustAttributed += 1;
    }
  }
  const distribution = Object.entries(counts)
    .map(([speaker, c]) => ({
      speaker,
      total: c.total,
      must: c.must,
      share_total: totalAttributed ? c.total / totalAttributed : 0,
      share_must: mustAttributed ? c.must / mustAttributed : 0,
    }))
    .sort((a, b) => b.total - a.total);
  const dominant = distribution[0];
  const totalThreshold = input.total_threshold ?? policy.speaker_fairness_total_threshold;
  const mustThreshold = input.must_threshold ?? policy.speaker_fairness_must_threshold;
  const warn = Boolean(
    dominant && (dominant.share_total > totalThreshold || dominant.share_must > mustThreshold)
  );
  return {
    mission_id: input.mission_id,
    total_items: items.length,
    attributed_items: totalAttributed,
    unattributed_items: items.length - totalAttributed,
    distribution,
    dominant_speaker: dominant?.speaker ?? null,
    warn,
    warn_reason: warn
      ? `dominant speaker '${dominant!.speaker}' has share_total=${dominant!.share_total.toFixed(2)}, share_must=${dominant!.share_must.toFixed(2)}`
      : null,
    generated_at: nowIso(),
  };
}

export async function generateReminderMessageOp(input: {
  item: ActionItem;
  mission_id?: string;
  work_item_id?: string;
  days_overdue?: number;
  tone?: 'friendly' | 'formal' | 'urgent';
  language?: string;
  policy?: MeetingFacilitatorPolicy;
}): Promise<{ channel: string; text: string; cc?: string[] }> {
  const backend = getReasoningBackend();
  const tone = input.tone ?? 'friendly';
  const language = input.language ?? 'ja';
  const channel = input.item.assignee.channel_handle ?? 'unspecified';
  const overdue = input.days_overdue ?? 0;
  const policy = input.policy ?? loadMeetingFacilitatorPolicy();
  const prompt = [
    'You draft a SHORT reminder message about an outstanding action item.',
    'Output ONLY a JSON object: { "text": str (≤ 3 sentences) }',
    'No prose, no code fence.',
    `Tone: ${tone}. Language: ${language}.`,
    `Recipient label: ${input.item.assignee.label}.`,
    `Action item: "${input.item.title}".`,
    input.item.due_at ? `Original due: ${input.item.due_at}.` : 'No firm deadline was set.',
    overdue > 0 ? `Days overdue: ${overdue}.` : 'Not yet overdue, this is a check-in.',
    'Do not threaten escalation. Do not invent context. Suggest one concrete next step.',
  ].join('\n');
  const raw = await delegateMeetingReasoning({
    backend,
    prompt,
    context: `reminder:${input.item.item_id}`,
    mission_id: input.mission_id,
    work_item_id: input.work_item_id,
    task_id: `reminder-${input.item.item_id}`,
  });
  let text = '';
  try {
    const parsed = parseMeetingModelObject(extractFirstJsonBlock(raw));
    text = typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    // Fall back to a deterministic template if parse fails.
    text = `Reminder: ${input.item.title}.${input.item.due_at ? ` Original due ${input.item.due_at}.` : ''}`;
  }
  // HR-2 chain-of-command: CC the manager handle when priority=must,
  // when the recipient has missed the reminder several times, or when
  // the action item is restricted. Threshold lives in the
  // MeetingFacilitatorPolicy (defaults to 3 from the env var).
  const cc: string[] = [];
  const managerHandle = input.item.policy?.manager_handle;
  if (managerHandle) {
    const sent = input.item.reminders?.length ?? 0;
    const shouldCc =
      input.item.priority === 'must' ||
      input.item.policy?.restricted === true ||
      sent >= policy.reminder_cc_after_n;
    if (shouldCc) cc.push(managerHandle);
  }
  return { channel, text, ...(cc.length ? { cc } : {}) };
}

export interface ActionItemReminderSweepReport {
  generated_at: string;
  missions_scanned: number;
  missions_with_pending_items: number;
  reminders_sent: number;
  outbox_messages_sent: number;
  outbox_message_ids: string[];
  missions: Array<{
    mission_id: string;
    pending_items: number;
    reminders_sent: number;
    outbox_messages_sent: number;
    outbox_message_ids: string[];
  }>;
}

/** Run the governed, typed reminder sweep used by the scheduled pipeline. */
export async function runActionItemReminderSweepOp(input?: {
  mission_ids?: string[];
  tone?: 'friendly' | 'formal' | 'urgent';
  language?: string;
  max_items_per_mission?: number;
  report_path?: string;
}): Promise<ActionItemReminderSweepReport> {
  const tone = input?.tone ?? 'friendly';
  const language = input?.language ?? 'ja';
  const maxItemsPerMission = input?.max_items_per_mission ?? 20;
  const now = new Date();
  const sweepDayKey = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const sweepSentAt = `${sweepDayKey}T00:00:00.000Z`;
  const existingOutbox = new Set(
    listSlackOutboxMessages({ includeTenantNamespaces: true })
      .filter((message) => typeof message.correlation_id === 'string')
      .map((message) => message.correlation_id as string)
  );
  const missions = listMissionSummaries('active').filter((mission) =>
    input?.mission_ids?.length ? input.mission_ids.includes(mission.id) : true
  );
  const report: ActionItemReminderSweepReport = {
    generated_at: nowIso(),
    missions_scanned: missions.length,
    missions_with_pending_items: 0,
    reminders_sent: 0,
    outbox_messages_sent: 0,
    outbox_message_ids: [],
    missions: [],
  };

  for (const mission of missions) {
    const pending = listOthersPending(mission.id)
      .map((item) => ({ item, days_overdue: computeDaysOverdue(item.due_at, now) }))
      .sort((a, b) => {
        if (a.days_overdue !== b.days_overdue) return b.days_overdue - a.days_overdue;
        const aDue = itemSortTimestamp(a.item.due_at) ?? itemSortTimestamp(a.item.created_at);
        const bDue = itemSortTimestamp(b.item.due_at) ?? itemSortTimestamp(b.item.created_at);
        if (aDue !== bDue) return aDue - bDue;
        if (a.item.priority !== b.item.priority) {
          return priorityRank(b.item.priority) - priorityRank(a.item.priority);
        }
        return a.item.item_id.localeCompare(b.item.item_id);
      })
      .slice(0, maxItemsPerMission)
      .map((entry) => entry.item);
    if (pending.length === 0) continue;

    report.missions_with_pending_items += 1;
    let remindersSent = 0;
    let outboxMessagesSent = 0;
    const outboxMessageIds: string[] = [];

    for (const item of pending) {
      const reminder = await generateReminderMessageOp({
        item,
        days_overdue: computeDaysOverdue(item.due_at, now),
        tone,
        language,
      });
      const primaryCorrelationId = `${mission.id}:${item.item_id}:${sweepDayKey}`;
      const primaryAlreadyRecorded = item.reminders?.some(
        (record) => record.sent_at === sweepSentAt && record.channel === reminder.channel
      );
      if (!primaryAlreadyRecorded) {
        appendReminder({
          mission_id: mission.id,
          item_id: item.item_id,
          reminder: {
            sent_at: sweepSentAt,
            channel: reminder.channel,
            message: reminder.text,
            relationship: 'primary',
          },
        });
        remindersSent += 1;
      }
      for (const ccChannel of reminder.cc ?? []) {
        const ccAlreadyRecorded = item.reminders?.some(
          (record) => record.sent_at === sweepSentAt && record.channel === ccChannel
        );
        if (ccAlreadyRecorded) continue;
        appendReminder({
          mission_id: mission.id,
          item_id: item.item_id,
          reminder: {
            sent_at: sweepSentAt,
            channel: ccChannel,
            message: reminder.text,
            relationship: 'cc_manager',
          },
        });
        remindersSent += 1;
      }
      if (!existingOutbox.has(primaryCorrelationId)) {
        const outboxMessageId = enqueueSlackOutboxMessage({
          correlationId: primaryCorrelationId,
          channel: reminder.channel,
          threadTs: item.item_id,
          text: [
            `Mission ${mission.id}`,
            `Item ${item.item_id}: ${item.title}`,
            reminder.text,
          ].join('\n'),
          source: 'system',
        });
        existingOutbox.add(primaryCorrelationId);
        outboxMessagesSent += 1;
        outboxMessageIds.push(outboxMessageId);
        report.outbox_message_ids.push(outboxMessageId);
      }
    }

    report.reminders_sent += remindersSent;
    report.outbox_messages_sent += outboxMessagesSent;
    report.missions.push({
      mission_id: mission.id,
      pending_items: pending.length,
      reminders_sent: remindersSent,
      outbox_messages_sent: outboxMessagesSent,
      outbox_message_ids: outboxMessageIds,
    });
  }

  safeWriteFile(
    assertSafeRepositoryPath(
      pathResolver.rootResolve(
        input?.report_path ?? 'active/shared/tmp/action-item-reminders-report.json'
      ),
      { allowMissingLeaf: true }
    ),
    JSON.stringify(report, null, 2)
  );
  return report;
}

function priorityRank(priority?: 'must' | 'should' | 'could' | 'wont'): number {
  switch (priority) {
    case 'must':
      return 3;
    case 'should':
      return 2;
    case 'could':
      return 1;
    case 'wont':
    default:
      return 0;
  }
}

function itemSortTimestamp(value?: string): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function computeDaysOverdue(dueAt?: string, now = new Date()): number {
  if (!dueAt) return 0;
  const parsed = Date.parse(dueAt);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor((now.getTime() - parsed) / (24 * 60 * 60 * 1000)));
}
