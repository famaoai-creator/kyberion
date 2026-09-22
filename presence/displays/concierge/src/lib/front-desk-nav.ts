/**
 * FD-00c/FD-01c: pure payload builder for `GET /api/front-desk/nav`. Reads
 * the shared menu definition (`@agent/core/front-desk-nav`) and renders its
 * label/sublabel keys through the server-side vocabulary resolver
 * (`@agent/core/t`) so the concierge rail and the presence-studio rail
 * render byte-identical labels from the same source.
 *
 * Kept separate from the route handler (matching every other
 * `src/app/api/*` route in this app) so it can be unit-tested without
 * constructing a `NextRequest`.
 */
import { t, type VocabularyKey } from '@agent/core/t';
import {
  DEFAULT_FRONT_DESK_PORTS,
  FRONT_DESK_HELP_LINK,
  readFrontDeskSurfacePorts,
  resolveFrontDeskMenu,
  type FrontDeskRole,
  type FrontDeskSurfacePorts,
} from '@agent/core/front-desk-nav';

export type FrontDeskLocale = 'ja' | 'en';

export interface FrontDeskNavItem {
  id: string;
  label: string;
  sublabel: string;
  href: string;
  external: boolean;
  allowed: boolean;
  min_role: FrontDeskRole;
}

export interface FrontDeskNavPayload {
  ok: true;
  locale: FrontDeskLocale;
  current_surface: 'concierge';
  items: FrontDeskNavItem[];
  help: { label: string; href: string };
  brand_tagline: string;
  aria_label: string;
  tenant_switch_aria: string;
  role_labels: { owner: string; approver: string; operator: string; viewer: string };
  tenant_viewing_summary: string;
  tenant_viewing_single: string;
}

/** `en*` -> `en`; everything else (including absent) -> `ja`, matching `resolveConciergeLocale`. */
export function resolveFrontDeskNavLocale(value: string | null | undefined): FrontDeskLocale {
  return value?.toLowerCase().startsWith('en') ? 'en' : 'ja';
}

export interface BuildFrontDeskNavPayloadInput {
  locale: FrontDeskLocale;
  role: FrontDeskRole;
  /** Injectable for tests; defaults to the real manifest-backed reader. */
  ports?: Partial<FrontDeskSurfacePorts>;
}

export function buildFrontDeskNavPayload(
  input: BuildFrontDeskNavPayloadInput
): FrontDeskNavPayload {
  const { locale, role } = input;
  const ports: FrontDeskSurfacePorts = {
    ...DEFAULT_FRONT_DESK_PORTS,
    ...(input.ports ?? readFrontDeskSurfacePorts()),
  };
  const menu = resolveFrontDeskMenu({ currentSurface: 'concierge', ports, role });
  const tr = (key: string) => t(key as VocabularyKey, undefined, locale);
  // `FRONT_DESK_HELP_LINK.surface` is a fixed presence-studio literal today,
  // but this stays a runtime string comparison (not a type narrowing) so it
  // keeps working if that ever changes.
  const helpExternal = (FRONT_DESK_HELP_LINK.surface as string) !== 'concierge';
  const helpHref = helpExternal
    ? `http://127.0.0.1:${ports[FRONT_DESK_HELP_LINK.surface]}${FRONT_DESK_HELP_LINK.path}`
    : FRONT_DESK_HELP_LINK.path;

  return {
    ok: true,
    locale,
    current_surface: 'concierge',
    items: menu.map((item) => ({
      id: item.id,
      label: tr(item.label_key),
      sublabel: tr(item.sublabel_key),
      href: item.href,
      external: item.external,
      allowed: item.allowed,
      min_role: item.min_role,
    })),
    help: {
      label: tr(FRONT_DESK_HELP_LINK.label_key),
      href: helpHref,
    },
    brand_tagline: tr('front_desk:brand_tagline'),
    aria_label: tr('front_desk:nav_aria_label'),
    tenant_switch_aria: tr('front_desk:tenant_switch_aria'),
    role_labels: {
      owner: tr('front_desk:role_owner'),
      approver: tr('front_desk:role_approver'),
      operator: tr('front_desk:role_operator'),
      viewer: tr('front_desk:role_viewer'),
    },
    // Kept as un-interpolated templates (`{role}` / `{count}`) — the rail
    // fills them per-viewer from `role_labels` and `tenants.length`.
    tenant_viewing_summary: tr('front_desk:tenant_viewing_summary'),
    tenant_viewing_single: tr('front_desk:tenant_viewing_single'),
  };
}
