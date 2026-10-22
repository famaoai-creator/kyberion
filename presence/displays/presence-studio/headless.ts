import {
  availableHeadlessOperationIds,
  createHeadlessEnvelope,
  filterHeadlessManifestForViewer,
  type HeadlessApiManifest,
  type HeadlessOperationDescriptor,
  type HeadlessResourceDescriptor,
} from '@agent/core/headless-surface-contract';
import { nowIso } from '@agent/core/foundation';
import { listApprovalRequests } from '@agent/core/governance/approval-store';
import { listArtifactRecords } from '@agent/core/workforce/artifact-record';
import { listProjectRecords } from '@agent/core/project/project-registry';
import type { A2UIMessage } from '@agent/core/a2ui';
import {
  narrowPresenceStudioTenant,
  presenceStudioHeadlessScope,
  presenceStudioRecordInScope,
  toSurfaceAuthorizationContext,
  PresenceStudioViewerError,
  type PresenceStudioViewerContext,
} from './security.js';
import { authorizeSurfaceContextOperation } from '@agent/core/surface/surface-authn';

const PRESENCE_OPERATIONS: readonly HeadlessOperationDescriptor[] = [
  {
    operation_id: 'presence.overview.read',
    resource: 'overview',
    method: 'GET',
    path: '/api/headless/overview',
    description: 'Read scoped projects, pending approvals, and outcomes for Presence Studio.',
    effect: 'read',
    required_role: 'readonly',
    required_permissions: ['surface.headless.read'],
    input_schema: {
      type: 'object',
      properties: { tenant: { type: 'string' } },
      additionalProperties: false,
    },
    output_schema: { type: 'object', description: 'PresenceStudioOverview projection.' },
    a2ui_projection: true,
  },
  {
    operation_id: 'presence.overview.a2ui',
    resource: 'overview',
    method: 'GET',
    path: '/api/headless/a2ui/overview',
    description: 'Read the scoped Presence Studio overview as A2UI messages.',
    effect: 'read',
    required_role: 'readonly',
    required_permissions: ['surface.headless.read'],
    input_schema: {
      type: 'object',
      properties: { tenant: { type: 'string' } },
      additionalProperties: false,
    },
    output_schema: { type: 'object', description: 'A2UI message list.' },
    a2ui_projection: true,
  },
  // AU-02/03 (A2UI COMPONENT HOST PLAN): the component host and its first flow.
  {
    operation_id: 'presence.components.read',
    resource: 'components',
    method: 'GET',
    path: '/api/components',
    description:
      'Read the UI component registry filtered for the viewer (flows, views, placement).',
    effect: 'read',
    required_role: 'readonly',
    required_permissions: ['surface.headless.read'],
    input_schema: {
      type: 'object',
      properties: { locale: { type: 'string' } },
      additionalProperties: false,
    },
    output_schema: { type: 'object', description: 'Component registry projection.' },
    a2ui_projection: false,
  },
  {
    operation_id: 'presence.hearing.view.a2ui',
    resource: 'hearing',
    method: 'GET',
    path: '/api/headless/a2ui/hearing',
    description: 'Read one hearing session as A2UI messages plus the actions the viewer may take.',
    effect: 'read',
    required_role: 'readonly',
    required_permissions: ['surface.headless.read'],
    input_schema: {
      type: 'object',
      properties: { session: { type: 'string' }, locale: { type: 'string' } },
      required: ['session'],
      additionalProperties: false,
    },
    output_schema: { type: 'object', description: 'A2UI message list + action descriptors.' },
    a2ui_projection: true,
  },
  {
    operation_id: 'presence.hearing.answer',
    resource: 'hearing',
    method: 'POST',
    path: '/api/hearing/:session/answer',
    description:
      'Answer the hearing question the companion asked (lands on the asked requirement).',
    effect: 'write',
    required_role: 'localadmin',
    required_permissions: ['surface.headless.write'],
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        request_id: { type: 'string' },
        locale: { type: 'string' },
        scenario_ref: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output_schema: { type: 'object', description: 'Hearing record, next question, phases.' },
    a2ui_projection: false,
  },
  {
    operation_id: 'presence.hearing.decide',
    resource: 'hearing',
    method: 'POST',
    path: '/api/hearing/:session/decide',
    description: 'Record the human decision on a fully answered hearing.',
    effect: 'write',
    required_role: 'localadmin',
    required_permissions: ['surface.headless.write'],
    input_schema: { type: 'object', additionalProperties: false },
    output_schema: { type: 'object', description: 'Decided hearing record.' },
    a2ui_projection: false,
  },
  {
    operation_id: 'presence.hearing.handoff',
    resource: 'hearing',
    method: 'POST',
    path: '/api/hearing/:session/handoff',
    description: 'Hand a decided hearing off as a mission with an alignment request.',
    effect: 'write',
    required_role: 'localadmin',
    required_permissions: ['surface.headless.write'],
    input_schema: { type: 'object', additionalProperties: false },
    output_schema: { type: 'object', description: 'Mission id and approval request id.' },
    a2ui_projection: false,
  },
];

const PRESENCE_RESOURCES: readonly HeadlessResourceDescriptor[] = [
  {
    resource: 'overview',
    description: 'Scoped project, approval, and outcome overview.',
    query_path: '/api/headless/overview',
    a2ui_path: '/api/headless/a2ui/overview',
  },
  {
    resource: 'components',
    description: 'UI component registry (flows and views the host assembles).',
    query_path: '/api/components',
  },
  {
    resource: 'hearing',
    description: 'One hearing session as a flow component.',
    query_path: '/api/headless/a2ui/hearing',
    a2ui_path: '/api/headless/a2ui/hearing',
  },
];

export function buildPresenceHeadlessManifest(): HeadlessApiManifest {
  return {
    api_version: '1',
    surface: 'presence-studio',
    resources: PRESENCE_RESOURCES.map((resource) => ({ ...resource })),
    operations: PRESENCE_OPERATIONS.map((operation) => ({
      ...operation,
      input_schema: { ...operation.input_schema },
      output_schema: { ...operation.output_schema },
    })),
  };
}

export function presenceManifestForViewer(
  viewer: PresenceStudioViewerContext
): HeadlessApiManifest {
  return filterHeadlessManifestForViewer(
    toSurfaceAuthorizationContext(viewer),
    buildPresenceHeadlessManifest(),
    authorizeSurfaceContextOperation
  );
}

export function authorizePresenceOperation(
  viewer: PresenceStudioViewerContext,
  operationId: string,
  resource?: { tenantSlug?: string; organizationId?: string; projectId?: string; tier?: string }
): void {
  const operation = buildPresenceHeadlessManifest().operations.find(
    (candidate) => candidate.operation_id === operationId
  );
  if (!operation)
    throw new PresenceStudioViewerError(403, `unknown headless operation: ${operationId}`);
  const decision = authorizeSurfaceContextOperation({
    context: toSurfaceAuthorizationContext(viewer),
    operation: {
      operationId: operation.operation_id,
      effect: operation.effect,
      requiredRole: operation.required_role,
      requiredPermissions: operation.required_permissions,
    },
    resource,
    surface: 'presence-studio',
  });
  if (!decision.allowed) throw new PresenceStudioViewerError(403, decision.reason);
}

function scopedViewer(viewer: PresenceStudioViewerContext, requestedTenant?: string) {
  const tenantSlugs = narrowPresenceStudioTenant(viewer, requestedTenant);
  return { ...viewer, tenantSlugs };
}

export function readPresenceHeadlessOverview(
  viewer: PresenceStudioViewerContext,
  requestedTenant?: string
) {
  const scoped = scopedViewer(viewer, requestedTenant);
  return {
    generated_at: nowIso(),
    projects: listProjectRecords().filter((item) => presenceStudioRecordInScope(scoped, item)),
    approvals: listApprovalRequests({ status: 'pending' }).filter((item) =>
      presenceStudioRecordInScope(scoped, item)
    ),
    outcomes: listArtifactRecords().filter((item) => presenceStudioRecordInScope(scoped, item)),
  };
}

export function presenceEnvelope<T>(
  resource: string,
  data: T,
  viewer: PresenceStudioViewerContext
) {
  const manifest = presenceManifestForViewer(viewer);
  return createHeadlessEnvelope({
    surface: 'presence-studio',
    resource,
    data,
    scope: presenceStudioHeadlessScope(viewer),
    manifest,
    authorizationContext: toSurfaceAuthorizationContext(viewer),
    authorize: authorizeSurfaceContextOperation,
  });
}

export function presenceAvailableOperations(viewer: PresenceStudioViewerContext): string[] {
  return availableHeadlessOperationIds(
    toSurfaceAuthorizationContext(viewer),
    buildPresenceHeadlessManifest(),
    authorizeSurfaceContextOperation
  );
}

export function buildPresenceOverviewA2UI(
  overview: ReturnType<typeof readPresenceHeadlessOverview>
): A2UIMessage[] {
  const surfaceId = 'presence-overview';
  return [
    {
      createSurface: {
        surfaceId,
        catalogId: 'expressive-surface',
        title: 'Presence Studio',
      },
    },
    {
      updateComponents: {
        surfaceId,
        components: [
          {
            id: 'presence-projects',
            type: 'display:list',
            props: { title: 'Projects', items: overview.projects },
          },
          {
            id: 'presence-approvals',
            type: 'display:list',
            props: { title: 'Approval Queue', items: overview.approvals },
          },
          {
            id: 'presence-outcomes',
            type: 'display:list',
            props: { title: 'Outcomes', items: overview.outcomes },
          },
        ],
      },
    },
    {
      updateDataModel: {
        surfaceId,
        data: overview as unknown as Record<string, unknown>,
      },
    },
  ];
}
