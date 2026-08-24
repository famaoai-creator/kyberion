import {
  availableHeadlessOperationIds,
  createHeadlessEnvelope,
  listApprovalRequests,
  listArtifactRecords,
  listProjectRecords,
  type A2UIMessage,
  type HeadlessApiManifest,
  type HeadlessOperationDescriptor,
  type HeadlessResourceDescriptor,
} from '@agent/core';
import {
  narrowPresenceStudioTenant,
  presenceStudioHeadlessScope,
  presenceStudioRecordInScope,
  type PresenceStudioViewerContext,
} from './security.js';

const PRESENCE_OPERATIONS: readonly HeadlessOperationDescriptor[] = [
  {
    operation_id: 'presence.overview.read',
    resource: 'overview',
    method: 'GET',
    path: '/api/headless/overview',
    description: 'Read scoped projects, pending approvals, and outcomes for Presence Studio.',
    effect: 'read',
    required_role: 'readonly',
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
    input_schema: {
      type: 'object',
      properties: { tenant: { type: 'string' } },
      additionalProperties: false,
    },
    output_schema: { type: 'object', description: 'A2UI message list.' },
    a2ui_projection: true,
  },
];

const PRESENCE_RESOURCES: readonly HeadlessResourceDescriptor[] = [
  {
    resource: 'overview',
    description: 'Scoped project, approval, and outcome overview.',
    query_path: '/api/headless/overview',
    a2ui_path: '/api/headless/a2ui/overview',
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
    generated_at: new Date().toISOString(),
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
  const manifest = buildPresenceHeadlessManifest();
  return createHeadlessEnvelope({
    surface: 'presence-studio',
    resource,
    data,
    scope: presenceStudioHeadlessScope(viewer),
    manifest,
  });
}

export function presenceAvailableOperations(viewer: PresenceStudioViewerContext): string[] {
  return availableHeadlessOperationIds(
    viewer.source === 'loopback' ? 'localadmin' : 'readonly',
    buildPresenceHeadlessManifest()
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
