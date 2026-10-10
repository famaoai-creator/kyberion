import type { NextRequest } from 'next/server';
import { scimListResponse, scimUserResourceType } from '@agent/core/organization/scim-protocol';
import { handleScim, scimResponse } from '../../../../lib/scim-server';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  return handleScim(req, (_principal, baseUrl) =>
    scimResponse(scimListResponse([scimUserResourceType(baseUrl)], 1, 1))
  );
}
