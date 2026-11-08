// WI-11 / WI-15: presence-studio's adapter for the one work-inventory scope rule
// the hearing hand-off reads and writes with (`hearing-routes.ts`; the rule
// itself lives in `libs/core/surface/hearing-completion.ts`).
// The 業務の自動化候補 panel that used to be served from here
// (`/api/front-desk/work-inventory`, `/api/work-inventory-vocabulary`) moved
// with the 進み具合 page to Concierge 仕事 › 依頼
// (`presence/displays/concierge/src/app/api/work-inventory/candidates`,
// Kyberion server phase 2). Concierge mirrors this rule in
// `src/lib/work-inventory-member.ts`.
import type { WorkInventoryScope } from '@agent/core/workforce/work-inventory';
import {
  hearingWorkInventoryHandoffHref,
  hearingWorkInventoryScope,
} from '@agent/core/surface/hearing-completion';
import type { PresenceStudioViewerContext } from './security.js';

/**
 * The viewer's first tenant slug -> that tenant's scope. Without a concrete
 * tenant — no tenant, or the loopback fallback `'all'` a local owner gets
 * when no tenant is configured — only a loopback session (the local machine
 * owner) resolves to the personal scope; a remote viewer resolves to `null`
 * (no single scope), never to someone's personal inventory.
 */
export function resolveWorkInventoryScopeForViewer(
  viewer: PresenceStudioViewerContext
): WorkInventoryScope | null {
  return hearingWorkInventoryScope(viewer);
}

/**
 * Where the work-inventory hand-off sends the person (仕事 › 依頼 on
 * Concierge, `scopedHref` already carries the viewer's scope). An entry filed
 * under the personal scope is listed there only in the personal view, so the
 * link selects it; a tenant-scoped entry keeps its `tenant`.
 */
export function workInventoryHandoffHref(
  scopedHref: string,
  viewer: PresenceStudioViewerContext
): string {
  return hearingWorkInventoryHandoffHref(scopedHref, viewer);
}
