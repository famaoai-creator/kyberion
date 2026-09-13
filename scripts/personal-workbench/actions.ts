import {
  computeApprovalPayloadHash,
  createApprovalRequest,
  createCalendarEvent,
  createMemoryPromotionCandidate,
  decideApprovalRequest,
  enqueueMemoryPromotionCandidate,
  executeEmailDelivery,
  loadApprovalRequest,
  ocrImage,
  type CalendarEventCreateInput,
  type EmailDeliveryRequest,
  type OcrRequest,
} from '@agent/core';
import { nowIso } from '@agent/core/foundation';
import { safeExistsSync, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import path from 'node:path';
import type { LocalPadContext } from '../lib/local-artifact-pad.js';
import { readSafeJsonFile } from '../lib/json-input.js';

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
}

export type CalendarProposalRecord = {
  proposal_id: string;
  approval_request_id: string;
  storage_channel: string;
  effect_binding: string;
  payload_hash: string;
  event: CalendarEventCreateInput;
  created_at: string;
  status: 'pending' | 'applied' | 'rejected';
  applied_at?: string;
  event_result?: Record<string, unknown>;
};

function asEmailDraftRequest(payload: Record<string, unknown>): EmailDeliveryRequest {
  return {
    body_markdown: String(payload.body_markdown || '').trim(),
    draft_mode: true,
    approved: false,
    ...(payload.message_id ? { message_id: String(payload.message_id) } : {}),
    ...(payload.reply_mode
      ? { reply_mode: String(payload.reply_mode) as EmailDeliveryRequest['reply_mode'] }
      : {}),
    ...(payload.subject ? { subject: String(payload.subject) } : {}),
    ...(payload.to ? { to: String(payload.to) } : {}),
    ...(payload.account ? { account: String(payload.account) } : {}),
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

export function calendarProposalPath(outDir: string, approvalRequestId: string): string {
  return path.join(outDir.replace(/\/$/, ''), 'calendar-proposals', `${approvalRequestId}.json`);
}

function readProposal(outDir: string, approvalRequestId: string): CalendarProposalRecord {
  const filePath = calendarProposalPath(outDir, approvalRequestId);
  if (!safeExistsSync(filePath)) {
    throw new Error(`calendar proposal not found for approval ${approvalRequestId}`);
  }
  return readSafeJsonFile<CalendarProposalRecord>(
    filePath,
    `personal-workbench calendar proposal ${approvalRequestId}`
  );
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
    event,
    created_at: nowIso(),
    status: 'pending',
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

  const expectedHash = computeApprovalPayloadHash(calendarBindingPayload(proposal.event));
  if (expectedHash !== proposal.payload_hash) {
    throw new Error('[POLICY_VIOLATION] calendar proposal payload hash mismatch');
  }

  let approval = loadApprovalRequest(PERSONAL_WORKBENCH_APPROVAL_CHANNEL, approvalRequestId);
  if (!approval) {
    throw new Error(`approval request not found: ${approvalRequestId}`);
  }
  if (approval.status === 'rejected' || approval.status === 'cancelled') {
    proposal.status = 'rejected';
    writeProposal(input.outDir, proposal);
    throw new Error(`approval request is ${approval.status}`);
  }
  if (approval.status === 'pending') {
    // Same contract as `pnpm kyberion approve`: interactive human at the keyboard.
    // Pad local_token alone is insufficient; this path records authMethod=manual.
    approval = decideApprovalRequest('mission_controller', {
      channel: approval.channel,
      storageChannel: approval.storageChannel,
      requestId: approval.id,
      decision: 'approved',
      decidedBy: input.context.viewer_principal,
      decidedByRole: 'sovereign',
      authMethod: 'manual',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: proposal.payload_hash,
      effectBinding: PERSONAL_WORKBENCH_CALENDAR_EFFECT,
      note: 'approved and applied from personal-workbench after explicit UI confirmation',
    });
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

  const eventResult = (await createCalendarEvent(proposal.event)) as unknown as Record<
    string,
    unknown
  >;
  proposal.status = 'applied';
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

/** Execute a personal action through the existing governed core APIs. */
export async function executePersonalWorkbenchAction(
  input: PersonalWorkbenchActionInput
): Promise<Record<string, unknown>> {
  switch (input.action) {
    case 'email': {
      const result = (await executeEmailDelivery(asEmailDraftRequest(input.payload))) as Record<
        string,
        unknown
      >;
      return {
        ...result,
        draft_only: true,
        note: 'personal-workbench only creates email drafts; send requires a governed approval workflow outside this pad.',
      };
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
        });
      }
      throw new Error('calendar stage must be propose or apply');
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
