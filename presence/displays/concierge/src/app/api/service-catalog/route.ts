import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContextAsync } from '@agent/core/authority';
import { loadServiceEndpointsCatalog } from '@agent/core/service/service-endpoint-registry';
import { resolveConciergeViewer } from '../../../lib/viewer-context';

const headers = { 'cache-control': 'no-store' };

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
      setup_command: `pnpm onboarding -- --services-only --service ${id}`,
    }));
    return NextResponse.json({ ok: true, services }, { headers });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers }
    );
  }
}
