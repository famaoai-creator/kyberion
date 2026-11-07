import { NextRequest, NextResponse } from 'next/server';
import { resolveConciergeInstallationAccess } from '../../../../lib/installation-access';
import { resolveConciergeSelectedViewer } from '../../../../lib/selected-tenant';
import { readWorkInventoryPanel } from '../../../../lib/work-inventory-panel';

export const dynamic = 'force-dynamic';

/**
 * 仕事 › 依頼's 業務の自動化候補 panel (moved from presence-studio
 * `GET /api/front-desk/work-inventory`). Read-only; the viewer and the
 * header's company selection are resolved server-side, never a
 * client-supplied tenant or member id. Never answers 500: an unreadable store
 * is an empty panel (`lib/work-inventory-panel.ts`).
 */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) return resolved.response;
  const personalView = resolved.selection.mode === 'personal';
  return NextResponse.json(
    readWorkInventoryPanel(resolved.context, {
      personalView,
      // Only asked for the personal view: the installation owner (attested
      // loopback peer + bound owner principal) sees their own inventory.
      installationOwner:
        personalView && resolveConciergeInstallationAccess(resolved.viewer, 'read', req).allowed,
    }),
    {
      headers: { 'Cache-Control': 'private, no-store' },
    }
  );
}
