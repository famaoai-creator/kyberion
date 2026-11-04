import { opsApiPath } from './ops-api-path';
import { parsePlanPreviewResponse, type ClientPlanPreview } from './plan-preview-response';
import {
  parseMissionApprovalResponse,
  parseMissionProposalResponse,
} from './agent-mutation-response';

/**
 * Mission planning on `/work` (MSN-SHELL-IA-20261105): the same governed flow
 * the console's former missions section used — preview through
 * `POST /api/ops/plan-preview`, then propose and `approve_mission` through
 * `POST /api/ops/agent` under one session. No step is skipped or retried here;
 * the routes re-check the viewer and admission.
 */

export type PlanTier = 'personal' | 'confidential' | 'public';

export interface PlanDraft {
  requestText: string;
  missionType: string;
  assignedPersona: string;
  tier: PlanTier;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class PlanFlowError extends Error {
  constructor(
    readonly code:
      | 'request_required'
      | 'preview_failed'
      | 'preview_invalid'
      | 'preview_required'
      | 'preview_stale'
      | 'proposal_failed'
      | 'proposal_invalid'
      | 'approval_failed'
      | 'approval_invalid'
  ) {
    super(code);
  }
}

export async function requestPlanPreview(
  draft: PlanDraft,
  locale: string,
  fetchImpl: FetchLike = fetch
): Promise<ClientPlanPreview> {
  if (!draft.requestText.trim()) throw new PlanFlowError('request_required');
  const response = await fetchImpl(opsApiPath('/plan-preview'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...draft, locale }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new PlanFlowError('preview_failed');
  const parsed = parsePlanPreviewResponse(payload);
  if (!parsed) throw new PlanFlowError('preview_invalid');
  return parsed.preview;
}

export async function approvePlanAndStart(
  input: {
    preview: ClientPlanPreview | null;
    stale: boolean;
    sessionId: string | null;
    requestText: string;
    locale: string;
  },
  fetchImpl: FetchLike = fetch
): Promise<{ missionId: string }> {
  if (!input.preview) throw new PlanFlowError('preview_required');
  if (input.stale) throw new PlanFlowError('preview_stale');
  const sessionId = input.sessionId || input.preview.missionId;
  const proposalResponse = await fetchImpl(opsApiPath('/agent'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: input.requestText,
      sessionId,
      locale: input.locale,
      requesterId: 'chronos-ui',
    }),
  });
  const proposalPayload = await proposalResponse.json().catch(() => null);
  if (!proposalResponse.ok) throw new PlanFlowError('proposal_failed');
  if (!parseMissionProposalResponse(proposalPayload)) throw new PlanFlowError('proposal_invalid');
  const confirmResponse = await fetchImpl(opsApiPath('/agent'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'approve_mission',
      sessionId,
      locale: input.locale,
      requesterId: 'chronos-ui',
    }),
  });
  const confirmPayload = await confirmResponse.json().catch(() => null);
  if (!confirmResponse.ok) throw new PlanFlowError('approval_failed');
  const approval = parseMissionApprovalResponse(confirmPayload);
  if (!approval) throw new PlanFlowError('approval_invalid');
  return { missionId: approval.mission.missionId };
}
