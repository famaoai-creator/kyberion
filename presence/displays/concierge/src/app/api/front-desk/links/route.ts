import { NextRequest, NextResponse } from 'next/server';
import { resolveSurfaceBrowserUrl } from '@agent/core/surface/surface-url';
import { resolveConciergeSelectedViewer } from '../../../../lib/selected-tenant';
import { conciergeErrorResponse } from '../../../../lib/viewer-context';

/**
 * FD-06: `GET /api/front-desk/links` — resolves cross-surface links that
 * `/settings` needs but that must never be hardcoded in client code (plan
 * §2.6 "ポート番号をハードコードしない", same rule `readFrontDeskSurfacePorts`
 * enforces for the rail). Today this is only the 詳細設定 → 管制塔
 * (chronos-mirror-v2) link; the port comes from the surface manifest, never
 * a literal, with `CHRONOS_MIRROR_DEFAULT_PORT` as the only fallback and
 * only ever read server-side.
 */
export const dynamic = 'force-dynamic';

const CHRONOS_MIRROR_SURFACE_ID = 'chronos-mirror-v2';
const CHRONOS_MIRROR_DEFAULT_PORT = 3000;

/** 設定 › エージェントと自律度 › メディアエンジン: Studio's engine settings page. */
function resolveStudioEngineConfigHref(): string | null {
  try {
    return resolveSurfaceBrowserUrl('presence-studio') + '/engine-config';
  } catch {
    return null;
  }
}

function resolveChronosMirrorHref(): string {
  try {
    return resolveSurfaceBrowserUrl(CHRONOS_MIRROR_SURFACE_ID) + '/';
  } catch {
    return `http://127.0.0.1:${CHRONOS_MIRROR_DEFAULT_PORT}/`;
  }
}

export function GET(req: NextRequest) {
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const chronosHref = resolveChronosMirrorHref();
    const studioEngineConfig = resolveStudioEngineConfigHref();
    return NextResponse.json(
      {
        ok: true,
        chronos_url: chronosHref,
        ...(studioEngineConfig ? { studio_engine_config_url: studioEngineConfig } : {}),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
