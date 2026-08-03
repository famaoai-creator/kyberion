import { NextRequest, NextResponse } from 'next/server';
import { pathResolver, safeExecResult, safeExistsSync } from '@agent/core';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import {
  conciergeText,
  resolveConciergeLocale,
  type ConciergeMessageKey,
} from '../../../../lib/i18n';
import { findHygieneInquiry, readMissionStatus } from '../../../../lib/hygiene-server';

export const dynamic = 'force-dynamic';

/**
 * CS-03 停滞ミッション伺いカード — record the HUMAN decision on a stalled
 * mission. Design principle (§0 of the CS plan): this gate is never automated.
 * The route runs only when the operator explicitly clicked 開始する/取りやめる
 * and confirmed; there is no scheduler, no auto-retry, and no default decision.
 *
 * Mission state changes go exclusively through scripts/mission_controller.ts
 * (repo invariant), invoked the same way chronos-mirror-v2 does
 * (api/agent/route.ts): the built controller under dist/ with
 * MISSION_ROLE=mission_controller and cwd at the repo root.
 */

const ALLOWED_DECISIONS = ['start', 'cancel'] as const;
type HygieneDecision = (typeof ALLOWED_DECISIONS)[number];

const MISSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const CONTROLLER_RELATIVE = 'dist/scripts/mission_controller.js';
// `start` replays governance gates and can touch git; give it room but stay bounded.
const CONTROLLER_TIMEOUT_MS = 120_000;

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;

  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
  const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
    conciergeText(key, locale, params);

  try {
    const { id } = await context.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const decision = ALLOWED_DECISIONS.includes(body?.decision as HygieneDecision)
      ? (body.decision as HygieneDecision)
      : null;
    const note =
      typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 2000) : '';
    if (!id || !MISSION_ID_PATTERN.test(id) || !decision) {
      return NextResponse.json({ ok: false, error: t('api.hygiene.invalid') }, { status: 400 });
    }

    const missionId = id.toUpperCase();
    // Only missions the hygiene report currently classifies as stalled are
    // actionable here — the card list and this guard read the same report, so
    // the route can never reach beyond what the operator was shown.
    const inquiry = findHygieneInquiry(missionId);
    if (!inquiry) {
      return NextResponse.json({ ok: false, error: t('api.hygiene.not_found') }, { status: 404 });
    }

    const rootDir = pathResolver.rootDir();
    const controllerPath = pathResolver.rootResolve(CONTROLLER_RELATIVE);
    if (!safeExistsSync(controllerPath)) {
      console.error(`[concierge/hygiene] mission controller build missing: ${controllerPath}`);
      return NextResponse.json({ ok: false, error: t('api.hygiene.failed') }, { status: 503 });
    }

    const args =
      decision === 'start'
        ? [CONTROLLER_RELATIVE, 'start', missionId]
        : [CONTROLLER_RELATIVE, 'cancel', missionId, ...(note ? ['--note', note] : [])];
    const result = safeExecResult(process.execPath, args, {
      env: { ...process.env, MISSION_ROLE: 'mission_controller' },
      cwd: rootDir,
      timeoutMs: CONTROLLER_TIMEOUT_MS,
      maxOutputMB: 5,
    });

    // Full controller output stays server-side; the UI gets a short honest verdict.
    console.log(
      `[concierge/hygiene] ${decision} ${missionId} exit=${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
    );

    // Exit code 0 alone is not success: the controller logs-and-returns on
    // refusals (unmet prerequisites, missing state). Verify the transition on
    // disk — start must leave the mission active, cancel records status
    // 'failed' with a cancel note (see libs/core/mission-lifecycle.ts).
    const statusAfter = readMissionStatus(missionId);
    const succeeded =
      result.status === 0 &&
      (decision === 'start' ? statusAfter === 'active' : statusAfter !== 'planned');
    if (!succeeded) {
      return NextResponse.json({ ok: false, error: t('api.hygiene.failed') }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      result: {
        mission_id: missionId,
        decision,
        message: t(decision === 'start' ? 'api.hygiene.started' : 'api.hygiene.cancelled', {
          title: inquiry.title,
        }),
      },
    });
  } catch (error) {
    console.error(
      `[concierge/hygiene] decision route failed: ${error instanceof Error ? error.stack || error.message : String(error)}`
    );
    return NextResponse.json({ ok: false, error: t('api.hygiene.failed') }, { status: 500 });
  }
}
