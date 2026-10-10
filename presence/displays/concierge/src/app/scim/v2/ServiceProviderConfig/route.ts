import type { NextRequest } from 'next/server';
import { scimServiceProviderConfig } from '@agent/core/organization/scim-protocol';
import { handleScim, scimResponse } from '../../../../lib/scim-server';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  return handleScim(req, (_principal, baseUrl) => scimResponse(scimServiceProviderConfig(baseUrl)));
}
