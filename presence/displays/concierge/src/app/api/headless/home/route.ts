import { NextRequest, NextResponse } from 'next/server';
import {
  authorizeConciergeOperation,
  conciergeEnvelope,
  parseConciergeLimit,
  readConciergeHome,
} from '../../../../lib/headless-projections';
import { readConciergeScopeQuery } from '../../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const scopeQuery = readConciergeScopeQuery(req.nextUrl.searchParams);
    authorizeConciergeOperation(resolved.context, 'concierge.home.read', {
      tenantSlug: scopeQuery.tenant,
      organizationId: scopeQuery.organizationId,
      projectId: scopeQuery.projectId,
    });
    const summary = readConciergeHome(resolved.context, {
      ...scopeQuery,
      limit: parseConciergeLimit(req.nextUrl.searchParams.get('limit')),
    });
    return NextResponse.json(conciergeEnvelope('home', summary, resolved.context));
  } catch (error) {
    return conciergeErrorResponse(error);
  }
}
