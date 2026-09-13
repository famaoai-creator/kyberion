import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  executeEmailDelivery,
  ocrImage,
  type EmailDeliveryRequest,
  type OcrRequest,
} from '@agent/core';
import { safeExistsSync } from '@agent/core/secure-io';
import type { LocalPadContext } from '../lib/local-artifact-pad.js';

export type PersonalWorkbenchAction = 'email' | 'calendar' | 'ocr' | 'knowledge';

export interface PersonalWorkbenchActionInput {
  action: PersonalWorkbenchAction;
  payload: Record<string, unknown>;
  /** Ignored for external effects — browser checkboxes are not human approval. */
  approved?: boolean;
  context: LocalPadContext;
  evidenceRef: string;
}

function asEmailDraftRequest(payload: Record<string, unknown>): EmailDeliveryRequest {
  return {
    body_markdown: String(payload.body_markdown || '').trim(),
    // Local pad token / UI checkbox is never send authority — drafts only.
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
    case 'calendar':
      throw new Error(
        'calendar changes are not executed from personal-workbench; capture a follow-up/task proposal or use a governed calendar workflow after human approval'
      );
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
