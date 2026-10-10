import type { NextRequest } from 'next/server';
import { scimListResponse, scimUserSchema } from '@agent/core/organization/scim-protocol';
import { handleScim, scimResponse } from '../../../../lib/scim-server';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  return handleScim(req, (_principal, baseUrl) =>
    scimResponse(scimListResponse([scimUserSchema(baseUrl)], 1, 1))
  );
}
