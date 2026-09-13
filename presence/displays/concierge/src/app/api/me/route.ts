import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import { readFrontDeskMe } from '@agent/core/front-desk-identity';
import { ensureOwnerMember } from '@agent/core/member-registry';
import { getBrowserOnboardingState } from '@agent/core/browser-onboarding';
import { conciergeAvailableOperations } from '../../../lib/headless-projections';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../lib/viewer-context';

/**
 * FD-01c: `GET /api/me` — the concierge half of the shared front-desk
 * identity contract (plan §2.4). Combines the server-resolved viewer scope
 * with tenant profiles and the onboarding flag into `FrontDeskMe`
 * (`libs/core/front-desk-identity.ts`), which both surfaces render
 * identically. Personal tier stays masked here exactly as it already is for
 * every other Concierge route — `resolveConciergeViewer` never grants it.
 */
export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    // `requestedTenant` is client-supplied and may only narrow the viewer's
    // already-resolved tenant set — `readFrontDeskMe` enforces that, it is
    // never treated as authorization by itself.
    const requestedTenant = req.nextUrl.searchParams.get('tenant');
    const onboarding = getBrowserOnboardingState();
    const onboarded =
      (onboarding.onboarding as Record<string, unknown> | null)?.status === 'complete';
    const me = withExecutionContext('sovereign_concierge', () => {
      // FD-07: the local owner is provisioned lazily and idempotently on the
      // first loopback visit (there is no login flow to hook), so
      // member.registered becomes true without a manual ceremony. Never
      // touches token viewers.
      if (resolved.context.source === 'loopback') {
        try {
          ensureOwnerMember();
        } catch (error) {
          console.error('[concierge/me] could not provision the owner member', error);
        }
      }
      return readFrontDeskMe(resolved.context, {
        requestedTenant,
        availableOperations: conciergeAvailableOperations(resolved.context),
        onboarded,
      });
    });
    return NextResponse.json(me, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
