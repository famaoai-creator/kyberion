import { NextRequest, NextResponse } from 'next/server';
import { isSameOriginMutation } from '@agent/core/surface/surface-session-cookie';
import { SurfaceManagementError } from '@agent/core/surface/surface-management-mutations';
import {
  listOrganizationParticipants,
  listOrganizationParticipantCandidates,
  listOrganizationBusinessRoles,
  setOrganizationParticipant,
  removeOrganizationParticipant,
} from '@agent/core/organization/organization-participants';
import {
  listManagedOrganizationAgents,
  showManagedOrganizationAgent,
  issueManagedOrganizationAgent,
  changeManagedOrganizationAgentLifecycle,
  reassignManagedOrganizationAgentAccountable,
} from '@agent/core/organization/organization-agent-management';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { conciergeCredential, guardConciergeRequest } from '../../../../lib/viewer-context';
import { managementAuthorization, managementContextId } from '../../../../lib/management-server';
import {
  readRequestObject,
  requireKnownRequestKeys,
  RequestInputError,
} from '../../../../lib/request-input';

export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'no-store' };
function failure(error: unknown) {
  if (error instanceof RequestInputError)
    return NextResponse.json(
      { ok: false, error: error.message, error_code: 'invalid_input' },
      { status: 400, headers: noStore }
    );
  if (error instanceof SurfaceManagementError)
    return NextResponse.json(
      { ok: false, error: error.message, error_code: error.code },
      { status: error.status, headers: noStore }
    );
  return NextResponse.json(
    {
      ok: false,
      error: 'Organization management is temporarily unavailable.',
      error_code: 'management_unavailable',
    },
    { status: 503, headers: noStore }
  );
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new SurfaceManagementError('invalid_input', 400, `${field} is required.`);
  return value;
}

export async function GET(req: NextRequest) {
  const denied = guardConciergeRequest(req);
  if (denied) return denied;
  try {
    const query = req.nextUrl.searchParams;
    for (const key of query.keys())
      if (!['tenant', 'organization_id'].includes(key) || query.getAll(key).length !== 1)
        throw new SurfaceManagementError('invalid_input', 400, 'Invalid organization selection.');
    const auth = managementAuthorization(req, text(query.get('tenant'), 'tenant'));
    const organizationId = text(query.get('organization_id'), 'organization_id');
    const [participants, candidates, agents] = await Promise.all([
      listOrganizationParticipants(auth, organizationId),
      listOrganizationParticipantCandidates(auth),
      listManagedOrganizationAgents(auth, { organizationId, includeRetired: true }),
    ]);
    return NextResponse.json(
      {
        ok: true,
        contextId: managementContextId(auth),
        actorId: auth.actorId,
        tenant: auth.tenantSlug,
        organizationId,
        participants,
        candidates,
        agents,
        roles: listOrganizationBusinessRoles(),
      },
      { headers: noStore }
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  if (
    conciergeCredential(req).source !== 'header' &&
    !isSameOriginMutation({
      method: req.method,
      headers: req.headers,
      expectedHost: req.headers.get('host') ?? new URL(req.url).host,
    })
  )
    return NextResponse.json(
      { ok: false, error: 'Cross-origin management request denied.', error_code: 'forbidden' },
      { status: 403, headers: noStore }
    );
  try {
    const parsed = await readRequestObject(req, 'organization command', [
      'tenant',
      'organizationId',
      'contextId',
      'operation',
      'actor',
      'roleIds',
      'expectedVersion',
      'slug',
      'displayName',
      'accountableHumanId',
      'nhiId',
      'action',
      'reason',
    ]);
    if (!parsed.ok)
      throw new SurfaceManagementError('invalid_input', 400, 'Invalid organization command.');
    const body = parsed.body;
    const auth = managementAuthorization(req, text(body.tenant, 'tenant'));
    const organizationId = text(body.organizationId, 'organizationId');
    if (body.contextId !== managementContextId(auth))
      throw new SurfaceManagementError(
        'context_changed',
        403,
        'The owner or scope changed. Reload before saving.'
      );
    const common = ['tenant', 'organizationId', 'contextId', 'operation'];
    let result: unknown;
    switch (body.operation) {
      case 'participant.assign':
        requireKnownRequestKeys(body, [...common, 'actor', 'roleIds', 'expectedVersion']);
        if (
          !Array.isArray(body.roleIds) ||
          !body.roleIds.every((value) => typeof value === 'string')
        )
          throw new SurfaceManagementError(
            'invalid_input',
            400,
            'roleIds must be an array of role identifiers.'
          );
        result = await setOrganizationParticipant(auth, {
          organizationId,
          actor: text(body.actor, 'actor'),
          roleIds: body.roleIds,
          ...(body.expectedVersion !== undefined
            ? { expectedVersion: text(body.expectedVersion, 'expectedVersion') }
            : {}),
        });
        break;
      case 'participant.remove':
        requireKnownRequestKeys(body, [...common, 'actor', 'expectedVersion']);
        result = await removeOrganizationParticipant(auth, {
          organizationId,
          actor: text(body.actor, 'actor'),
          expectedVersion: text(body.expectedVersion, 'expectedVersion'),
        });
        break;
      case 'agent.issue':
        requireKnownRequestKeys(body, [...common, 'slug', 'displayName', 'accountableHumanId']);
        result = await issueManagedOrganizationAgent(auth, {
          organizationId,
          slug: text(body.slug, 'slug'),
          displayName: text(body.displayName, 'displayName'),
          accountableHumanId: text(body.accountableHumanId, 'accountableHumanId'),
        });
        break;
      case 'agent.lifecycle':
        requireKnownRequestKeys(body, [...common, 'nhiId', 'action', 'reason', 'expectedVersion']);
        if (!['activate', 'suspend', 'retire'].includes(String(body.action)))
          throw new SurfaceManagementError('invalid_input', 400, 'Invalid lifecycle action.');
        if (
          (await showManagedOrganizationAgent(auth, text(body.nhiId, 'nhiId')))
            ?.home_organization_id !== organizationId
        )
          throw new SurfaceManagementError(
            'not_found',
            404,
            'Agent is not managed by the selected organization.'
          );
        result = await changeManagedOrganizationAgentLifecycle(auth, {
          nhiId: text(body.nhiId, 'nhiId'),
          action: body.action as 'activate' | 'suspend' | 'retire',
          reason: text(body.reason, 'reason'),
          expectedVersion: text(body.expectedVersion, 'expectedVersion'),
        });
        break;
      case 'agent.accountable':
        requireKnownRequestKeys(body, [
          ...common,
          'nhiId',
          'accountableHumanId',
          'reason',
          'expectedVersion',
        ]);
        if (
          (await showManagedOrganizationAgent(auth, text(body.nhiId, 'nhiId')))
            ?.home_organization_id !== organizationId
        )
          throw new SurfaceManagementError(
            'not_found',
            404,
            'Agent is not managed by the selected organization.'
          );
        result = await reassignManagedOrganizationAgentAccountable(auth, {
          nhiId: text(body.nhiId, 'nhiId'),
          accountableHumanId: text(body.accountableHumanId, 'accountableHumanId'),
          reason: text(body.reason, 'reason'),
          expectedVersion: text(body.expectedVersion, 'expectedVersion'),
        });
        break;
      default:
        throw new SurfaceManagementError('invalid_input', 400, 'Unknown organization operation.');
    }
    // The refreshed scoped snapshot is the public projection, not an arbitrary mutation result.
    void result;
    return NextResponse.json({ ok: true, operation: body.operation }, { headers: noStore });
  } catch (error) {
    return failure(error);
  }
}
