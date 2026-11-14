import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContextAsync } from '@agent/core/authority';
import { loadServiceEndpointsCatalog } from '@agent/core/service/service-endpoint-registry';
import { getServiceOnboardingCatalogEntry } from '@agent/core/service/service-onboarding-catalog';
import { resolveConciergeViewer } from '../../../lib/viewer-context';

const headers = { 'cache-control': 'no-store' };

// The services-only onboarding wizard only knows its catalog entries; for
// every other service the right first step is Secret Guard (or, when the
// service needs no credentials, the shared readiness report).
function setupCommandFor(
  id: string,
  record: { auth_strategy?: string; credential_suffixes?: Record<string, string[]> }
): string {
  if (getServiceOnboardingCatalogEntry(id)) {
    return `pnpm onboarding -- --services-only --service ${id}`;
  }
  const strategy = (record.auth_strategy ?? 'none').toLowerCase();
  if (strategy !== 'none' && strategy !== 'host-managed') {
    const suffix = record.credential_suffixes?.accessToken?.[0] ?? 'ACCESS_TOKEN';
    return `pnpm kyberion secret introduce ${id} ${suffix}`;
  }
  return 'pnpm service:setup';
}

export async function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const catalog = await withExecutionContextAsync('sovereign_concierge', () =>
      loadServiceEndpointsCatalog()
    );
    const services = Object.entries(catalog.services).map(([id, record]) => ({
      id,
      auth_strategy: record.auth_strategy ?? 'none',
      oauth: Boolean(record.oauth),
      credential_suffixes: Object.keys(record.credential_suffixes ?? {}),
      setup_command: setupCommandFor(id, record),
    }));
    return NextResponse.json({ ok: true, services }, { headers });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers }
    );
  }
}
