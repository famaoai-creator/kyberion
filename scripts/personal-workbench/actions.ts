import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  createCalendarEvent,
  executeEmailDelivery,
  ocrImage,
  type CalendarEventCreateInput,
  type EmailDeliveryRequest,
  type OcrRequest,
} from '@agent/core';
import type { LocalPadContext } from '../lib/local-artifact-pad.js';

export type PersonalWorkbenchAction = 'email' | 'calendar' | 'ocr' | 'knowledge';

export interface PersonalWorkbenchActionInput {
  action: PersonalWorkbenchAction;
  payload: Record<string, unknown>;
  approved?: boolean;
  context: LocalPadContext;
  evidenceRef: string;
}

function requireApproval(action: string, approved: boolean | undefined): void {
  if (approved !== true) {
    throw new Error(`${action} requires explicit human approval (approved=true)`);
  }
}

function asEmailRequest(payload: Record<string, unknown>): EmailDeliveryRequest {
  return {
    body_markdown: String(payload.body_markdown || '').trim(),
    draft_mode: false,
    approved: true,
    ...(payload.message_id ? { message_id: String(payload.message_id) } : {}),
    ...(payload.reply_mode
      ? { reply_mode: String(payload.reply_mode) as EmailDeliveryRequest['reply_mode'] }
      : {}),
    ...(payload.subject ? { subject: String(payload.subject) } : {}),
    ...(payload.to ? { to: String(payload.to) } : {}),
    ...(payload.account ? { account: String(payload.account) } : {}),
  };
}

function asCalendarRequest(payload: Record<string, unknown>): CalendarEventCreateInput {
  return {
    provider: payload.provider === 'm365' ? 'm365' : 'google-workspace',
    calendar_id: payload.calendar_id ? String(payload.calendar_id) : undefined,
    summary: String(payload.summary || ''),
    start: String(payload.start || ''),
    end: String(payload.end || ''),
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

/** Execute a personal action through the existing governed core APIs. */
export async function executePersonalWorkbenchAction(
  input: PersonalWorkbenchActionInput
): Promise<Record<string, unknown>> {
  switch (input.action) {
    case 'email':
      requireApproval('email sending', input.approved);
      return (await executeEmailDelivery(asEmailRequest(input.payload))) as Record<string, unknown>;
    case 'calendar':
      requireApproval('calendar changes', input.approved);
      return (await createCalendarEvent(asCalendarRequest(input.payload))) as unknown as Record<
        string,
        unknown
      >;
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
      return { candidate_id: candidate.candidate_id, status: candidate.status };
    }
  }
}
