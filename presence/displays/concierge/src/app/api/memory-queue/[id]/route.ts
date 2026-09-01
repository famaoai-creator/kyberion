import { NextRequest, NextResponse } from 'next/server';
import { loadMemoryPromotionCandidate } from '@agent/core/memory-promotion-queue';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExecResult,
  safeExistsSync,
  safeLstat,
} from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { readRequestObject } from '../../../../lib/request-input';
import {
  conciergeText,
  resolveConciergeLocale,
  type ConciergeMessageKey,
} from '../../../../lib/i18n';
import { resolveConciergeViewer } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

/**
 * CS-03 記憶昇格キュー — record the HUMAN decision on one memory-promotion
 * candidate. Design principle (§0 of the CS plan): nothing is approved or
 * rejected without an explicit confirmed click; there is no scheduler and no
 * default decision. Queue state changes go exclusively through
 * scripts/mission_controller.ts (`memory-approve` / `memory-reject`), invoked
 * the same way the hygiene decision route does: the built controller under
 * dist/ with MISSION_ROLE=mission_controller and cwd at the repo root.
 */

const ALLOWED_DECISIONS = ['approve', 'reject'] as const;
type MemoryDecision = (typeof ALLOWED_DECISIONS)[number];

const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const CONTROLLER_RELATIVE = 'dist/scripts/mission_controller.js';
const CONTROLLER_TIMEOUT_MS = 30_000;

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;

  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
  const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
    conciergeText(key, locale, params);

  try {
    const { id } = await context.params;
    const parsedBody = await readRequestObject(req, 'request body', ['decision']);
    if (!parsedBody.ok)
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    const { body } = parsedBody;
    const decision = ALLOWED_DECISIONS.includes(body?.decision as MemoryDecision)
      ? (body.decision as MemoryDecision)
      : null;
    if (!id || !CANDIDATE_ID_PATTERN.test(id) || !decision) {
      return NextResponse.json({ ok: false, error: t('api.memory.invalid') }, { status: 400 });
    }

    // Only candidates actually in the queue are actionable — the list pane and
    // this guard read the same JSONL, so the route can never reach beyond what
    // the operator was shown. Decisions are one-shot: a decided candidate is
    // no longer pending.
    const candidate = withExecutionContext('sovereign_concierge', () =>
      loadMemoryPromotionCandidate(id)
    );
    const visible =
      candidate &&
      resolved.context.tierAccess.includes(candidate.sensitivity_tier) &&
      (resolved.context.tenantSlugs === 'all'
        ? true
        : Boolean(
            candidate.scope?.tenant_slug &&
            resolved.context.tenantSlugs.includes(candidate.scope.tenant_slug)
          ));
    if (!visible) {
      return NextResponse.json({ ok: false, error: t('api.memory.not_found') }, { status: 404 });
    }
    if (candidate.status !== 'queued') {
      return NextResponse.json({ ok: false, error: t('api.memory.not_pending') }, { status: 409 });
    }

    const rootDir = pathResolver.rootDir();
    const controllerPath = pathResolver.rootResolve(CONTROLLER_RELATIVE);
    let controllerReady = false;
    try {
      const safeControllerPath = assertSafeRepositoryPath(controllerPath, {
        allowMissingLeaf: true,
      });
      controllerReady =
        safeExistsSync(safeControllerPath) && safeLstat(safeControllerPath).isFile();
    } catch {
      controllerReady = false;
    }
    if (!controllerReady) {
      console.error(`[concierge/memory-queue] mission controller build missing: ${controllerPath}`);
      return NextResponse.json({ ok: false, error: t('api.memory.failed') }, { status: 503 });
    }

    const subcommand = decision === 'approve' ? 'memory-approve' : 'memory-reject';
    const result = safeExecResult(
      process.execPath,
      [CONTROLLER_RELATIVE, subcommand, candidate.candidate_id],
      {
        env: { ...process.env, MISSION_ROLE: 'mission_controller' },
        cwd: rootDir,
        timeoutMs: CONTROLLER_TIMEOUT_MS,
        maxOutputMB: 5,
      }
    );

    // Full controller output stays server-side; the UI gets a short honest verdict.
    console.log(
      `[concierge/memory-queue] ${subcommand} ${candidate.candidate_id} exit=${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
    );

    // Exit code 0 alone is not success: the controller logs-and-returns on a
    // missing candidate. Verify the status transition on disk before claiming
    // anything (see scripts/mission_controller.ts approve/rejectMemoryCandidate).
    const after = withExecutionContext('sovereign_concierge', () =>
      loadMemoryPromotionCandidate(candidate.candidate_id)
    );
    const expected = decision === 'approve' ? 'approved' : 'rejected';
    if (result.status !== 0 || after?.status !== expected) {
      return NextResponse.json({ ok: false, error: t('api.memory.failed') }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      result: {
        id: candidate.candidate_id,
        decision,
        status: after.status,
        message: t(decision === 'approve' ? 'api.memory.approved' : 'api.memory.rejected'),
      },
    });
  } catch (error) {
    console.error(
      `[concierge/memory-queue] decision route failed: ${error instanceof Error ? error.stack || error.message : String(error)}`
    );
    return NextResponse.json({ ok: false, error: t('api.memory.failed') }, { status: 500 });
  }
}
