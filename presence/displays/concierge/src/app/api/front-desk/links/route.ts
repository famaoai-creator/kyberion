import { NextRequest, NextResponse } from 'next/server';
import { loadSurfaceManifest } from '@agent/core/surface-runtime';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';

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

function resolveChronosMirrorPort(): number {
  try {
    const manifest = loadSurfaceManifest();
    const surface = manifest.surfaces.find((entry) => entry.id === CHRONOS_MIRROR_SURFACE_ID);
    if (
      surface &&
      typeof surface.port === 'number' &&
      Number.isFinite(surface.port) &&
      surface.port > 0
    ) {
      return surface.port;
    }
  } catch {
    // Manifest absent/invalid (e.g. first boot before reconcile) — the
    // settings page still needs a link to render, so fall back rather than
    // failing the route.
  }
  return CHRONOS_MIRROR_DEFAULT_PORT;
}

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const chronosPort = resolveChronosMirrorPort();
    return NextResponse.json(
      { ok: true, chronos_url: `http://127.0.0.1:${chronosPort}/` },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
