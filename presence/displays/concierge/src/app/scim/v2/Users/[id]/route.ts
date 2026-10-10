import type { NextRequest } from 'next/server';
import {
  deactivateScimUser,
  getScimUser,
  patchScimUser,
  replaceScimUser,
} from '@agent/core/organization/scim-users';
import { handleScim, readScimBody, runScim, scimResponse } from '../../../../../lib/scim-server';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export function GET(req: NextRequest, context: Params) {
  return handleScim(req, async (principal, baseUrl) => {
    const { id } = await context.params;
    return scimResponse(runScim(principal, () => getScimUser(principal, id, baseUrl)));
  });
}

export function PUT(req: NextRequest, context: Params) {
  return handleScim(req, async (principal, baseUrl) => {
    const { id } = await context.params;
    const body = await readScimBody(req);
    return scimResponse(runScim(principal, () => replaceScimUser(principal, id, body, baseUrl)));
  });
}

export function PATCH(req: NextRequest, context: Params) {
  return handleScim(req, async (principal, baseUrl) => {
    const { id } = await context.params;
    const body = await readScimBody(req);
    return scimResponse(runScim(principal, () => patchScimUser(principal, id, body, baseUrl)));
  });
}

/** Deactivate (suspend). Kyberion never hard-deletes a member. */
export function DELETE(req: NextRequest, context: Params) {
  return handleScim(req, async (principal, baseUrl) => {
    const { id } = await context.params;
    runScim(principal, () => deactivateScimUser(principal, id, baseUrl));
    return scimResponse(null, 204);
  });
}
