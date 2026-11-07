import { NextResponse, type NextRequest } from 'next/server';
import { normalizeLocale } from '@agent/core/foundation/locale-normalize';
import {
  parseFirstJobReadRequest,
  parseFirstJobRequest,
} from '@agent/core/surface/first-job-contract';
import { readFirstJobSnapshot, resolveFirstJobViewer } from '@agent/core/surface/first-job';
import { readFirstJobSetup } from '@agent/core/surface/first-job-setup';
import {
  FRONT_DESK_RECEIPT_COMMAND,
  frontDeskArtifactRevisionCommand,
} from '@agent/core/surface/front-desk-execution-contract';
import {
  completeConversationTurn,
  conversationRef,
  ConversationStoreError,
  reserveConversationTurn,
} from '@agent/core/surface/front-desk-conversation-store';
import { resolveFirstJobGate } from '../../../lib/first-job-access';
import {
  FIRST_JOB_NO_STORE,
  firstJobFailure,
  firstJobGateFailure,
  firstJobQuery,
  firstJobUnexpected,
  readFirstJobBody,
} from '../../../lib/first-job-server';

export const dynamic = 'force-dynamic';

/**
 * 初めての仕事 (`/first-job`): the fixed diagnostic's read model and its one
 * request (moved from presence-studio `GET/POST /api/first-job`, Kyberion
 * server phase 2). The gate is `lib/first-job-access.ts`; the logic is the
 * shared `@agent/core/surface/first-job*` and front-desk conversation store.
 */
export function GET(req: NextRequest) {
  try {
    const gate = resolveFirstJobGate(req, false);
    if (gate.denial) return firstJobGateFailure(gate.denial, true);
    const { viewer, credential } = gate;
    const input = parseFirstJobReadRequest(firstJobQuery(req));
    if (!input || (input.locale !== undefined && !normalizeLocale(input.locale)))
      return firstJobFailure(400, 'first_job_invalid_request', true);
    const snapshot = readFirstJobSnapshot(viewer, input);
    return NextResponse.json(
      { ...snapshot, setup: readFirstJobSetup(viewer, credential, snapshot) },
      { headers: FIRST_JOB_NO_STORE }
    );
  } catch (error) {
    return firstJobUnexpected('GET /api/first-job', error, 'first_job_history_unavailable', true);
  }
}

export async function POST(req: NextRequest) {
  let reserved = false;
  try {
    const gate = resolveFirstJobGate(req, true);
    if (gate.denial) return firstJobGateFailure(gate.denial, true);
    const { viewer: authenticated, credential } = gate;
    const input = parseFirstJobRequest(await readFirstJobBody(req));
    if (
      !input ||
      (input.locale !== undefined && !normalizeLocale(input.locale)) ||
      Object.keys(firstJobQuery(req)).length !== 0
    )
      return firstJobFailure(400, 'first_job_invalid_request', true);
    const resolution = resolveFirstJobViewer(authenticated);
    if (resolution.ready === false)
      return firstJobFailure(409, 'first_job_' + resolution.status, true);
    const viewer = resolution.viewer;
    const ref = conversationRef(viewer);
    if (input.session_id && input.session_id !== ref.sessionId)
      return firstJobFailure(409, 'first_job_scope_changed', true);
    const revision = input.action === 'revise' ? input.artifactRevision : undefined;
    const command = revision
      ? frontDeskArtifactRevisionCommand(revision.format)
      : FRONT_DESK_RECEIPT_COMMAND;
    const turn = reserveConversationTurn(
      viewer,
      command,
      input.request_id,
      undefined,
      normalizeLocale(input.locale) ?? undefined,
      revision,
      { requireDiagnosticAdmission: true }
    );
    reserved = true;
    // The strict store contract provides an atomic diagnostic outbox and inert
    // acknowledgement. There is intentionally no conversation-runtime fallback.
    const reply = turn.routing?.reply;
    if (!reply) return firstJobFailure(503, 'first_job_admission_uncertain', false);
    if (turn.created) completeConversationTurn(viewer, turn.id, reply);
    const snapshot = readFirstJobSnapshot(authenticated, {
      session_id: ref.sessionId,
      locale: input.locale,
    });
    return NextResponse.json(
      {
        ...snapshot,
        setup: readFirstJobSetup(authenticated, credential, snapshot),
        request_id: input.request_id,
        replayed: !turn.created,
        mode: turn.created ? 'intake' : 'history',
        historySaved: true,
      },
      { headers: FIRST_JOB_NO_STORE }
    );
  } catch (error) {
    if (error instanceof ConversationStoreError) {
      const invalid = ['invalid_revision', 'invalid_text'].includes(error.code);
      const unavailable = error.code === 'invalid_history';
      return firstJobFailure(
        invalid ? 400 : unavailable ? 503 : 409,
        'first_job_' + error.code,
        !reserved && !unavailable
      );
    }
    return firstJobUnexpected('POST /api/first-job', error, 'first_job_admission_uncertain', false);
  }
}
