import type { NextRequest } from 'next/server';
import { createScimUser, listScimUsers } from '@agent/core/organization/scim-users';
import { handleScim, readScimBody, runScim, scimResponse } from '../../../../lib/scim-server';

export const dynamic = 'force-dynamic';

/** List the token tenant's users; `filter=userName eq "…"` / `externalId eq "…"`, startIndex/count paging. */
export function GET(req: NextRequest) {
  return handleScim(req, (principal, baseUrl) => {
    const params = req.nextUrl.searchParams;
    const list = runScim(principal, () =>
      listScimUsers(
        principal,
        {
          filter: params.get('filter'),
          startIndex: params.get('startIndex'),
          count: params.get('count'),
        },
        baseUrl
      )
    );
    return scimResponse(list);
  });
}

/** Provision a member in the token's tenant with its default role (never owner). */
export function POST(req: NextRequest) {
  return handleScim(req, async (principal, baseUrl) => {
    const body = await readScimBody(req);
    const user = runScim(principal, () => createScimUser(principal, body, baseUrl));
    return scimResponse(user, 201, { Location: user.meta.location });
  });
}
