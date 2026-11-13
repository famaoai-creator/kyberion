/**
 * The viewer role a surface adapter resolves for an HTTP / headless request:
 * `readonly` may read inside its scope, `localadmin` may also write. This is
 * the single declaration of the union; `ChronosAccessRole`,
 * `SurfaceAuthorizationRole`, `HeadlessViewerRole` and `PluginViewRole` are
 * deprecated aliases of it. It is a foundation leaf so the token registry
 * (authn), the authorization contract (surface) and the plugin view contract
 * can all import it without a layer inversion.
 *
 * It decides the surface permission set, not the authority role an execution
 * runs under, and not a member's standing (`MemberRole`).
 */
export const SURFACE_VIEWER_ROLES = Object.freeze(['readonly', 'localadmin'] as const);
export type SurfaceViewerRole = (typeof SURFACE_VIEWER_ROLES)[number];
