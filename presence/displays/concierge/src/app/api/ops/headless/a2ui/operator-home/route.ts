import { NextRequest, NextResponse } from 'next/server';
import { guardOpsRequest, requireOpsAccess } from '../../../../../../lib/ops/ops-request-guard';
import { buildOperatorHomeA2UI } from '../../../../../../lib/ops/headless-a2ui';
import { readHeadlessOperatorHome } from '../../../../../../lib/ops/headless-projections';
import {
  headlessEnvelope,
  headlessErrorResponse,
  parseHeadlessLimit,
  authorizeHeadlessOperation,
} from '../../../../../../lib/ops/headless-response';
import { resolveOpsViewerForRequest } from '../../../../../../lib/ops/ops-viewer';
import { readChronosOptionalStringParam } from '../../../../../../lib/ops/request-input';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const access = requireOpsAccess(req, 'readonly');
  if (access) return access;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    authorizeHeadlessOperation(resolvedViewer.context, 'chronos.operator_home.read', {
      tenantSlug: readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant')),
      organizationId: readChronosOptionalStringParam(
        req.nextUrl.searchParams.get('organization_id')
      ),
      projectId: readChronosOptionalStringParam(req.nextUrl.searchParams.get('project_id')),
    });
    const limit = parseHeadlessLimit(
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('limit')) ?? null,
      8,
      50
    );
    const summary = readHeadlessOperatorHome(resolvedViewer.context, {
      tenant: readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant')),
      organizationId: readChronosOptionalStringParam(
        req.nextUrl.searchParams.get('organization_id')
      ),
      projectId: readChronosOptionalStringParam(req.nextUrl.searchParams.get('project_id')),
      since: readChronosOptionalStringParam(req.nextUrl.searchParams.get('since')),
      limit,
    });
    return NextResponse.json(
      headlessEnvelope(
        'operator-home',
        { source_resource: 'operator-home', a2ui: buildOperatorHomeA2UI(summary) },
        resolvedViewer.context
      )
    );
  } catch (error) {
    return headlessErrorResponse(error);
  }
}
