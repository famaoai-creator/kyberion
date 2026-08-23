import {
  availableHeadlessOperationIds,
  buildCeoSurfaceSummary,
  createHeadlessEnvelope,
  type CeoSurfaceSummary,
  type HeadlessApiManifest,
  type HeadlessOperationDescriptor,
  type HeadlessResourceDescriptor,
} from '@agent/core';
import type { OperatorHomeScopeFilter } from '@agent/core/operator-home-summary';
import type { A2UIMessage } from '@agent/core/a2ui';
import {
  conciergeHeadlessScope,
  narrowConciergeScope,
  withConciergeViewerContext,
  type ConciergeViewerContext,
} from './viewer-context';

const CONCIERGE_OPERATIONS: readonly HeadlessOperationDescriptor[] = [
  {
    operation_id: 'concierge.home.read',
    resource: 'home',
    method: 'GET',
    path: '/api/headless/home',
    description: 'Read the scoped Concierge secretary home projection.',
    effect: 'read',
    required_role: 'readonly',
    input_schema: {
      type: 'object',
      properties: {
        tenant: { type: 'string' },
        organization_id: { type: 'string' },
        project_id: { type: 'string' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    output_schema: { type: 'object', description: 'CeoSurfaceSummary projection.' },
    a2ui_projection: true,
  },
  {
    operation_id: 'concierge.home.a2ui',
    resource: 'home',
    method: 'GET',
    path: '/api/headless/a2ui/home',
    description: 'Read the scoped Concierge home as A2UI messages.',
    effect: 'read',
    required_role: 'readonly',
    input_schema: {
      type: 'object',
      properties: {
        tenant: { type: 'string' },
        organization_id: { type: 'string' },
        project_id: { type: 'string' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    output_schema: { type: 'object', description: 'A2UI message list.' },
    a2ui_projection: true,
  },
];

const CONCIERGE_RESOURCES: readonly HeadlessResourceDescriptor[] = [
  {
    resource: 'home',
    description: 'Briefing, intent inbox, approval queue, outcomes, and exceptions.',
    query_path: '/api/headless/home',
    a2ui_path: '/api/headless/a2ui/home',
  },
];

export function buildConciergeHeadlessManifest(): HeadlessApiManifest {
  return {
    api_version: '1',
    surface: 'concierge',
    resources: CONCIERGE_RESOURCES.map((resource) => ({ ...resource })),
    operations: CONCIERGE_OPERATIONS.map((operation) => ({
      ...operation,
      input_schema: { ...operation.input_schema },
      output_schema: { ...operation.output_schema },
    })),
  };
}

export function readConciergeHome(
  viewer: ConciergeViewerContext,
  query: {
    tenant?: string | null;
    organizationId?: string | null;
    projectId?: string | null;
    limit?: number;
  }
): CeoSurfaceSummary {
  const narrowed = narrowConciergeScope(viewer, query);
  const scope: OperatorHomeScopeFilter = {
    tiers: viewer.tierAccess,
    tenantSlugs: narrowed.tenantSlugs,
    organizationIds: narrowed.organizationIds,
    projectIds: narrowed.projectIds,
  };
  return withConciergeViewerContext(viewer, () =>
    buildCeoSurfaceSummary({ scope, limit: query.limit || 20 })
  );
}

export function conciergeEnvelope<T>(resource: string, data: T, viewer: ConciergeViewerContext) {
  const manifest = buildConciergeHeadlessManifest();
  return createHeadlessEnvelope({
    surface: 'concierge',
    resource,
    data,
    scope: conciergeHeadlessScope(viewer),
    manifest,
  });
}

export function conciergeAvailableOperations(viewer: ConciergeViewerContext): string[] {
  return availableHeadlessOperationIds(viewer.role, buildConciergeHeadlessManifest());
}

export function buildConciergeHomeA2UI(summary: CeoSurfaceSummary): A2UIMessage[] {
  const surfaceId = 'concierge-home';
  return [
    {
      createSurface: {
        surfaceId,
        catalogId: 'expressive-surface',
        title: 'Concierge',
      },
    },
    {
      updateComponents: {
        surfaceId,
        components: [
          {
            id: 'concierge-briefing',
            type: 'display:hero',
            props: { title: 'Today', text: summary.briefing.sentence_ja },
          },
          {
            id: 'concierge-intent-inbox',
            type: 'display:list',
            props: { title: 'Intent Inbox', items: summary.intent_inbox },
          },
          {
            id: 'concierge-approval-queue',
            type: 'display:list',
            props: { title: 'Approval Queue', items: summary.approval_queue },
          },
          {
            id: 'concierge-outcome-feed',
            type: 'display:list',
            props: { title: 'Outcome Feed', items: summary.outcome_feed },
          },
          {
            id: 'concierge-exception-feed',
            type: 'display:list',
            props: { title: 'Exception Feed', items: summary.exception_feed },
          },
        ],
      },
    },
    {
      updateDataModel: {
        surfaceId,
        data: summary as unknown as Record<string, unknown>,
      },
    },
  ];
}

export function parseConciergeLimit(raw: string | null): number {
  if (!raw?.trim()) return 20;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error('invalid limit: expected an integer from 1 to 50');
  }
  return value;
}
