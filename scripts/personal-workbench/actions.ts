import {
  computeApprovalPayloadHash,
  createApprovalRequest,
  createCalendarEvent,
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  loadApprovalRequest,
  listCalendarAgenda,
  ocrImage,
  type CalendarEventCreateInput,
  type OcrRequest,
} from '@agent/core';
import { nowIso } from '@agent/core/foundation';
import { safeExistsSync, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { withLock } from '@agent/core/lock-utils';
import { assertSafeRepositoryPath } from '@agent/core/path-resolver';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { LocalPadContext } from '../lib/local-artifact-pad.js';
import { readSafeJsonFile } from '../lib/json-input.js';
import type { EventScope } from '@agent/core/event-scope';

export type PersonalWorkbenchAction = 'email' | 'calendar' | 'ocr' | 'knowledge';

export const PERSONAL_WORKBENCH_CALENDAR_EFFECT = 'calendar:create_event';
export const PERSONAL_WORKBENCH_APPROVAL_CHANNEL = 'personal-workbench';

export interface PersonalWorkbenchActionInput {
  action: PersonalWorkbenchAction;
  payload: Record<string, unknown>;
  /** For calendar apply: human intent confirmation in the UI (not a substitute for the approval record). */
  confirmed?: boolean;
  context: LocalPadContext;
  evidenceRef: string;
  /** Directory for calendar proposal artifacts (usually the pad --out). */
  outDir: string;
  /** Injectable gateway for deterministic reconciliation tests and hosts. */
  calendar_gateway?: PersonalWorkbenchCalendarGateway;
}

export interface PersonalWorkbenchCalendarGateway {
  createCalendarEvent: typeof createCalendarEvent;
  listCalendarAgenda: typeof listCalendarAgenda;
}

export type CalendarProposalRecord = {
  proposal_id: string;
  approval_request_id: string;
  storage_channel: string;
  effect_binding: string;
  payload_hash: string;
  /** Opaque marker used to prove an agenda event belongs to this proposal. */
  reconciliation_token?: string;
  event: CalendarEventCreateInput;
  created_at: string;
  status: 'pending' | 'applied' | 'rejected';
  execution_state?: 'idle' | 'in_flight' | 'unknown' | 'completed';
  execution_started_at?: string;
  applied_at?: string;
  event_result?: Record<string, unknown>;
};

function writeLocalEmailDraft(
  payload: Record<string, unknown>,
  outDir: string
): Record<string, unknown> {
  const body = String(payload.body_markdown || '').trim();
  if (!body) throw new Error('body_markdown is required');
  const to = String(payload.to || '').trim();
  const subject = String(payload.subject || '').trim() || 'Re: Inbox update';
  const draftId = createHash('sha256')
    .update(JSON.stringify({ to, subject, body }))
    .digest('hex')
    .slice(0, 24);
  const draftDir = path.join(outDir, 'email-drafts');
  const markdownPath = path.join(draftDir, `${draftId}.md`);
  const jsonPath = path.join(draftDir, `${draftId}.json`);
  safeMkdir(draftDir, { recursive: true });
  safeWriteFile(
    markdownPath,
    [`# Email draft`, ``, `To: ${to}`, `Subject: ${subject}`, ``, body, ``].join('\n'),
    { mkdir: true, encoding: 'utf8' }
  );
  safeWriteFile(
    jsonPath,
    JSON.stringify(
      {
        draft_id: draftId,
        draft_mode: true,
        to,
        subject,
        body_markdown: body,
        created_at: nowIso(),
        delivery: 'local-only',
      },
      null,
      2
    ),
    { mkdir: true, encoding: 'utf8' }
  );
  return {
    draft_id: draftId,
    status: 'drafted',
    draft_only: true,
    delivery: 'local-only',
    draft_path: markdownPath,
    json_path: jsonPath,
    note: 'この pad はローカル下書きだけを作成します。外部メールサービスへは接続しません。',
  };
}

export function parseCalendarEventPayload(
  payload: Record<string, unknown>
): CalendarEventCreateInput {
  const summary = String(payload.summary || '').trim();
  const start = String(payload.start || '').trim();
  const end = String(payload.end || '').trim();
  if (!summary || !start || !end) {
    throw new Error('calendar event requires summary, start, and end');
  }
  return {
    provider: payload.provider === 'm365' ? 'm365' : 'google-workspace',
    calendar_id: payload.calendar_id ? String(payload.calendar_id) : undefined,
    summary,
    start,
    end,
    description: payload.description ? String(payload.description) : undefined,
    location: payload.location ? String(payload.location) : undefined,
    attendees: Array.isArray(payload.attendees) ? payload.attendees.map(String) : undefined,
    time_zone: payload.time_zone ? String(payload.time_zone) : undefined,
    send_updates:
      payload.send_updates === 'all' ||
      payload.send_updates === 'externalOnly' ||
      payload.send_updates === 'none'
        ? payload.send_updates
        : undefined,
    with_meet: payload.with_meet === true,
  };
}

function sameCalendarInstant(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs)
    ? leftMs === rightMs
    : left.trim() === right.trim();
}

/** Match provider agenda results without guessing when more than one event fits. */
export function matchCalendarReconciliationEvents(
  proposal: Pick<CalendarProposalRecord, 'event' | 'reconciliation_token'>,
  events: readonly {
    id?: string;
    summary: string;
    start: string;
    end: string;
    description?: string;
  }[]
): readonly {
  id?: string;
  summary: string;
  start: string;
  end: string;
  description?: string;
}[] {
  const token = proposal.reconciliation_token?.trim();
  if (!token) return [];
  const marker = `[${token}]`;
  return events.filter(
    (candidate) =>
      candidate.summary.trim() === proposal.event.summary.trim() &&
      sameCalendarInstant(candidate.start, proposal.event.start) &&
      sameCalendarInstant(candidate.end, proposal.event.end) &&
      typeof candidate.description === 'string' &&
      candidate.description.includes(marker)
  );
}

function calendarBindingPayload(event: CalendarEventCreateInput): Record<string, unknown> {
  return {
    effect: PERSONAL_WORKBENCH_CALENDAR_EFFECT,
    provider: event.provider || 'google-workspace',
    calendar_id: event.calendar_id || 'primary',
    summary: event.summary,
    start: event.start,
    end: event.end,
    description: event.description || '',
    location: event.location || '',
    attendees: event.attendees || [],
    time_zone: event.time_zone || '',
    send_updates: event.send_updates || '',
    with_meet: event.with_meet === true,
  };
}

function reconciliationToken(payloadHash: string): string {
  return `kyberion-calendar-${payloadHash.slice(0, 24)}`;
}

function withReconciliationMarker(description: string | undefined, token: string): string {
  const marker = `[${token}]`;
  const base = description?.trim() || '';
  return base.includes(marker) ? base : [base, marker].filter(Boolean).join('\n\n');
}

function calendarProposalLockId(outDir: string, approvalRequestId: string): string {
  return `personal-workbench-calendar-${createHash('sha256')
    .update(`${outDir}:${approvalRequestId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

export function calendarProposalPath(outDir: string, approvalRequestId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(approvalRequestId)) {
    throw new Error('approval_request_id is invalid');
  }
  const safeOutDir = assertSafeRepositoryPath(outDir, { allowMissingLeaf: true });
  const filePath = path.resolve(safeOutDir, 'calendar-proposals', `${approvalRequestId}.json`);
  const relative = path.relative(path.resolve(safeOutDir), filePath);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('calendar proposal path escapes scoped workbench directory');
  }
  return filePath;
}

function readProposal(outDir: string, approvalRequestId: string): CalendarProposalRecord {
  const filePath = calendarProposalPath(outDir, approvalRequestId);
  if (!safeExistsSync(filePath)) {
    throw new Error(`calendar proposal not found for approval ${approvalRequestId}`);
  }
  const proposal = readSafeJsonFile<CalendarProposalRecord>(
    filePath,
    `personal-workbench calendar proposal ${approvalRequestId}`
  );
  if (
    proposal.approval_request_id !== approvalRequestId ||
    proposal.proposal_id !== `cal-${approvalRequestId}` ||
    proposal.effect_binding !== PERSONAL_WORKBENCH_CALENDAR_EFFECT
  ) {
    throw new Error('calendar proposal binding is invalid');
  }
  if (
    proposal.reconciliation_token &&
    proposal.reconciliation_token !== reconciliationToken(proposal.payload_hash)
  ) {
    throw new Error('calendar reconciliation token binding is invalid');
  }
  return proposal;
}

function sameScope(left: EventScope | undefined, right: EventScope): boolean {
  if (!left) return false;
  const keys: Array<keyof EventScope> = [
    'scope_kind',
    'tier',
    'tenant_slug',
    'organization_id',
    'project_id',
    'mission_id',
    'task_id',
    'session_id',
  ];
  return keys.every((key) => left[key] === right[key]);
}

function writeProposal(outDir: string, proposal: CalendarProposalRecord): string {
  const filePath = calendarProposalPath(outDir, proposal.approval_request_id);
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, JSON.stringify(proposal, null, 2), { mkdir: true, encoding: 'utf8' });
  return filePath;
}

export function proposeCalendarEvent(input: {
  payload: Record<string, unknown>;
  context: LocalPadContext;
  outDir: string;
  evidenceRef: string;
}): Record<string, unknown> {
  const event = parseCalendarEventPayload(input.payload);
  const bindingPayload = calendarBindingPayload(event);
  const payloadHash = computeApprovalPayloadHash(bindingPayload);
  const approval = createApprovalRequest('mission_controller', {
    channel: PERSONAL_WORKBENCH_APPROVAL_CHANNEL,
    storageChannel: PERSONAL_WORKBENCH_APPROVAL_CHANNEL,
    threadTs: nowIso(),
    correlationId: input.context.session_id,
    requestedBy: input.context.viewer_principal,
    draft: {
      title: `Calendar create: ${event.summary}`,
      summary: `${event.start} → ${event.end}`,
      details: event.description || undefined,
      severity: 'medium',
    },
    sourceText: JSON.stringify(event),
    accountability: {
      finalDecision: 'human_only',
      payloadHash,
      effectBinding: PERSONAL_WORKBENCH_CALENDAR_EFFECT,
    },
    scope: input.context.scope,
  });
  const proposal: CalendarProposalRecord = {
    proposal_id: `cal-${approval.id}`,
    approval_request_id: approval.id,
    storage_channel: PERSONAL_WORKBENCH_APPROVAL_CHANNEL,
    effect_binding: PERSONAL_WORKBENCH_CALENDAR_EFFECT,
    payload_hash: payloadHash,
    reconciliation_token: reconciliationToken(payloadHash),
    event,
    created_at: nowIso(),
    status: 'pending',
    execution_state: 'idle',
  };
  const proposalPath = writeProposal(input.outDir, proposal);
  return {
    stage: 'propose',
    status: 'pending',
    approval_request_id: approval.id,
    proposal_path: proposalPath,
    event,
    next_steps: [
      'Review the proposal in this pad, then confirm and apply.',
      `Or from CLI: pnpm kyberion approve ${approval.id} ${PERSONAL_WORKBENCH_APPROVAL_CHANNEL}`,
      'Then run calendar apply with the same approval_request_id if you approved via CLI.',
    ],
    evidence_ref: input.evidenceRef,
  };
}

export async function applyCalendarEvent(input: {
  payload: Record<string, unknown>;
  context: LocalPadContext;
  outDir: string;
  confirmed?: boolean;
  calendar_gateway?: PersonalWorkbenchCalendarGateway;
}): Promise<Record<string, unknown>> {
  const approvalRequestId = String(input.payload.approval_request_id || '').trim();
  if (!approvalRequestId) {
    throw new Error('approval_request_id is required to apply a calendar event');
  }
  return withLock(calendarProposalLockId(input.outDir, approvalRequestId), () =>
    applyCalendarEventUnlocked(input)
  );
}

async function applyCalendarEventUnlocked(input: {
  payload: Record<string, unknown>;
  context: LocalPadContext;
  outDir: string;
  confirmed?: boolean;
  calendar_gateway?: PersonalWorkbenchCalendarGateway;
}): Promise<Record<string, unknown>> {
  if (input.confirmed !== true) {
    throw new Error(
      'calendar apply requires confirmed=true after reviewing the proposal (UI confirmation of intent)'
    );
  }
  const approvalRequestId = String(input.payload.approval_request_id || '').trim();
  if (!approvalRequestId)
    throw new Error('approval_request_id is required to apply a calendar event');

  const proposal = readProposal(input.outDir, approvalRequestId);
  // Load and bind the approval before returning any proposal result.  The
  // proposal directory is scope-partitioned, but the approval record is the
  // authoritative tenant/tier and requester binding for an external effect.
  const approval = loadApprovalRequest(PERSONAL_WORKBENCH_APPROVAL_CHANNEL, approvalRequestId);
  if (!approval) {
    throw new Error(`approval request not found: ${approvalRequestId}`);
  }
  if (!sameScope(approval.scope, input.context.scope)) {
    throw new Error('calendar approval scope does not match the current viewer scope');
  }
  if (approval.requestedBy !== input.context.viewer_principal) {
    throw new Error('calendar approval requester does not match the current viewer');
  }
  const expectedHash = computeApprovalPayloadHash(calendarBindingPayload(proposal.event));
  if (expectedHash !== proposal.payload_hash) {
    throw new Error('[POLICY_VIOLATION] calendar proposal payload hash mismatch');
  }
  if (proposal.status === 'applied') {
    return {
      stage: 'apply',
      status: 'already_applied',
      approval_request_id: approvalRequestId,
      event_result: proposal.event_result || null,
    };
  }
  if (proposal.status === 'rejected') {
    throw new Error(`calendar proposal ${approvalRequestId} was rejected`);
  }
  if (proposal.execution_state === 'in_flight' || proposal.execution_state === 'unknown') {
    return {
      stage: 'apply',
      status: 'reconciliation_required',
      approval_request_id: approvalRequestId,
      note: '外部カレンダーへの反映結果が確定していないため、重複作成を避けて停止しました。provider 側を確認してから運用者が reconciliation してください。',
    };
  }

  if (approval.status === 'rejected' || approval.status === 'cancelled') {
    proposal.status = 'rejected';
    writeProposal(input.outDir, proposal);
    throw new Error(`approval request is ${approval.status}`);
  }
  if (approval.status === 'pending') {
    // UI confirmation expresses intent, but does not replace the governed
    // approval record.  Require an explicit approval through the normal
    // approval workflow before any provider write.
    return {
      stage: 'apply',
      status: 'approval_required',
      approval_request_id: approvalRequestId,
      approval_status: 'pending',
      note: '承認レコードが pending です。承認ワークフローで明示承認してから再実行してください。',
    };
  }
  if (approval.status !== 'approved' && approval.status !== 'applied') {
    throw new Error(`approval request is ${approval.status}; expected approved`);
  }
  if (
    approval.accountability?.payloadHash &&
    approval.accountability.payloadHash !== proposal.payload_hash
  ) {
    throw new Error('[POLICY_VIOLATION] approval payload hash does not match proposal');
  }

  proposal.execution_state = 'in_flight';
  proposal.execution_started_at = nowIso();
  writeProposal(input.outDir, proposal);
  let eventResult: Record<string, unknown>;
  try {
    const gateway = input.calendar_gateway ?? {
      createCalendarEvent,
      listCalendarAgenda,
    };
    eventResult = (await gateway.createCalendarEvent({
      ...proposal.event,
      ...(proposal.reconciliation_token
        ? {
            description: withReconciliationMarker(
              proposal.event.description,
              proposal.reconciliation_token
            ),
          }
        : {}),
      // Google Meet uses this as a provider idempotency key when requested.
      conference_request_id:
        proposal.event.conference_request_id || `kyberion-${proposal.approval_request_id}`,
    })) as unknown as Record<string, unknown>;
  } catch (error) {
    proposal.execution_state = 'unknown';
    writeProposal(input.outDir, proposal);
    throw error;
  }
  proposal.status = 'applied';
  proposal.execution_state = 'completed';
  proposal.applied_at = nowIso();
  proposal.event_result = eventResult;
  const proposalPath = writeProposal(input.outDir, proposal);
  return {
    stage: 'apply',
    status: 'applied',
    approval_request_id: approvalRequestId,
    approval_status: approval.status,
    proposal_path: proposalPath,
    event: proposal.event,
    event_result: eventResult,
  };
}

export async function reconcileCalendarEvent(input: {
  payload: Record<string, unknown>;
  context: LocalPadContext;
  outDir: string;
  calendar_gateway?: PersonalWorkbenchCalendarGateway;
}): Promise<Record<string, unknown>> {
  const approvalRequestId = String(input.payload.approval_request_id || '').trim();
  if (!approvalRequestId)
    throw new Error('approval_request_id is required to reconcile a calendar event');
  return withLock(calendarProposalLockId(input.outDir, approvalRequestId), () =>
    reconcileCalendarEventUnlocked(input)
  );
}

async function reconcileCalendarEventUnlocked(input: {
  payload: Record<string, unknown>;
  context: LocalPadContext;
  outDir: string;
  calendar_gateway?: PersonalWorkbenchCalendarGateway;
}): Promise<Record<string, unknown>> {
  const approvalRequestId = String(input.payload.approval_request_id || '').trim();
  if (!approvalRequestId)
    throw new Error('approval_request_id is required to reconcile a calendar event');
  const proposal = readProposal(input.outDir, approvalRequestId);
  const approval = loadApprovalRequest(PERSONAL_WORKBENCH_APPROVAL_CHANNEL, approvalRequestId);
  if (!approval) throw new Error(`approval request not found: ${approvalRequestId}`);
  if (!sameScope(approval.scope, input.context.scope)) {
    throw new Error('calendar approval scope does not match the current viewer scope');
  }
  if (approval.requestedBy !== input.context.viewer_principal) {
    throw new Error('calendar approval requester does not match the current viewer');
  }
  if (approval.status === 'rejected' || approval.status === 'cancelled') {
    throw new Error(`approval request is ${approval.status}`);
  }
  if (approval.status !== 'approved' && approval.status !== 'applied') {
    return {
      stage: 'reconcile',
      status: 'not_needed',
      approval_request_id: approvalRequestId,
      approval_status: approval.status,
      note: 'provider 照合は明示承認済みの proposal にだけ実行できます。',
    };
  }
  const expectedHash = computeApprovalPayloadHash(calendarBindingPayload(proposal.event));
  if (expectedHash !== proposal.payload_hash) {
    throw new Error('[POLICY_VIOLATION] calendar proposal payload hash mismatch');
  }
  if (proposal.status === 'applied') {
    return {
      stage: 'reconcile',
      status: 'already_applied',
      approval_request_id: approvalRequestId,
      event_result: proposal.event_result || null,
    };
  }
  if (proposal.status === 'rejected') {
    throw new Error(`calendar proposal ${approvalRequestId} was rejected`);
  }
  if (proposal.execution_state !== 'in_flight' && proposal.execution_state !== 'unknown') {
    return {
      stage: 'reconcile',
      status: 'not_needed',
      approval_request_id: approvalRequestId,
      execution_state: proposal.execution_state || 'idle',
    };
  }
  let agenda;
  try {
    const gateway = input.calendar_gateway ?? {
      createCalendarEvent,
      listCalendarAgenda,
    };
    agenda = await gateway.listCalendarAgenda({
      provider: proposal.event.provider,
      calendar_id: proposal.event.calendar_id,
      time_min: proposal.event.start,
      time_max: proposal.event.end,
      time_zone: proposal.event.time_zone,
      query: proposal.event.summary,
      max_results: 50,
    });
  } catch {
    return {
      stage: 'reconcile',
      status: 'reconciliation_required',
      approval_request_id: approvalRequestId,
      candidates: 0,
      note: 'provider の照合が利用できません。proposal は unknown のまま保持します。',
    };
  }
  const matches = matchCalendarReconciliationEvents(proposal, agenda.events);
  if (matches.length !== 1) {
    return {
      stage: 'reconcile',
      status: 'reconciliation_required',
      approval_request_id: approvalRequestId,
      candidates: matches.length,
      note:
        matches.length === 0
          ? '一致する provider event が見つかりません。再作成せず運用者の確認を待ちます。'
          : '複数の provider event が一致しました。誤った確定を避けるため運用者の確認を待ちます。',
    };
  }
  const matched = matches[0]!;
  proposal.status = 'applied';
  proposal.execution_state = 'completed';
  proposal.applied_at = nowIso();
  proposal.event_result = { reconciled: true, matched_event: matched };
  writeProposal(input.outDir, proposal);
  return {
    stage: 'reconcile',
    status: 'reconciled',
    approval_request_id: approvalRequestId,
    event_result: proposal.event_result,
  };
}

/** Execute a personal action through governed/local-only boundaries. */
export async function executePersonalWorkbenchAction(
  input: PersonalWorkbenchActionInput
): Promise<Record<string, unknown>> {
  switch (input.action) {
    case 'email': {
      return writeLocalEmailDraft(input.payload, input.outDir);
    }
    case 'calendar': {
      const stage = String(input.payload.stage || 'propose').trim();
      if (stage === 'propose') {
        return proposeCalendarEvent({
          payload: input.payload,
          context: input.context,
          outDir: input.outDir,
          evidenceRef: input.evidenceRef,
        });
      }
      if (stage === 'apply') {
        return applyCalendarEvent({
          payload: input.payload,
          context: input.context,
          outDir: input.outDir,
          confirmed: input.confirmed,
          calendar_gateway: input.calendar_gateway,
        });
      }
      if (stage === 'reconcile') {
        return reconcileCalendarEvent({
          payload: input.payload,
          context: input.context,
          outDir: input.outDir,
          calendar_gateway: input.calendar_gateway,
        });
      }
      throw new Error('calendar stage must be propose, apply, or reconcile');
    }
    case 'ocr': {
      const request: OcrRequest = {
        path: String(input.payload.path || ''),
        language: input.payload.language ? String(input.payload.language) : undefined,
        mode: input.payload.mode
          ? (String(input.payload.mode) as OcrRequest['mode'])
          : 'privacy_first',
        extractStructure: input.payload.extractStructure === true,
      };
      return (await ocrImage(request)) as unknown as Record<string, unknown>;
    }
    case 'knowledge': {
      const summary = String(input.payload.summary || '').trim();
      if (!summary) throw new Error('knowledge summary is required');
      if (!input.evidenceRef.trim() || !safeExistsSync(input.evidenceRef)) {
        throw new Error(
          'knowledge enqueue requires an existing evidence handoff file; capture first, then run /action knowledge'
        );
      }
      const scope = {
        ...input.context.scope,
        owner_nhi: input.context.viewer_principal,
        allowed_audience: [input.context.viewer_principal],
        promotion_policy: 'human_review' as const,
        provenance_refs: [input.evidenceRef],
      };
      const candidate = createMemoryPromotionCandidate({
        sourceType: 'artifact',
        sourceRef: `personal-workbench:${input.context.session_id}`,
        proposedMemoryKind: 'heuristic',
        summary,
        evidenceRefs: [input.evidenceRef],
        sensitivityTier: 'personal',
        scope,
      });
      enqueueMemoryPromotionCandidate(candidate);
      return {
        candidate_id: candidate.candidate_id,
        status: candidate.status,
        note: 'queued as personal promotion candidate; not published',
      };
    }
  }
}
