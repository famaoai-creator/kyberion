import { NextRequest, NextResponse } from 'next/server';
import { t, type VocabularyKey } from '@agent/core/t';
import {
  frontDeskRoleFromViewer,
  readFrontDeskSurfaceUrls,
  resolveFrontDeskMenu,
} from '@agent/core/front-desk-nav';
import { guardRequest } from '../../../../lib/api-guard';
import { resolveViewerContextForRequest } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

/**
 * The shared front-desk rail rendered for Chronos, so Chronos is one window
 * of the unified shell instead of a separate app: Chronos items are
 * same-origin links, everything else points at the surface that hosts it.
 */
export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const locale = req.nextUrl.searchParams.get('locale')?.toLowerCase().startsWith('en')
    ? 'en'
    : 'ja';
  const tr = (key: string) => t(key as VocabularyKey, undefined, locale);
  const role = frontDeskRoleFromViewer({ role: resolvedViewer.context.role });
  const items = resolveFrontDeskMenu({
    currentSurface: 'chronos-mirror-v2',
    urls: readFrontDeskSurfaceUrls(),
    role,
  })
    .filter((item) => item.allowed)
    .map((item) => ({
      id: item.id,
      label: tr(item.label_key),
      hint: tr(item.sublabel_key),
      group_label: tr(item.group_key),
      icon: item.icon,
      href: item.href,
      external: item.external,
      path: item.path,
    }));
  return NextResponse.json(
    {
      ok: true,
      locale,
      items,
      aria_label: tr('front_desk:nav_aria_label'),
      brand_tagline: tr('front_desk:brand_tagline'),
    },
    { headers: { 'Cache-Control': 'private, no-store' } }
  );
}
