/**
 * Framework-neutral contracts for surface APIs.
 *
 * This is deliberately separate from A2UI: headless consumers need stable
 * data/operation semantics even when they do not render a Kyberion surface.
 */

export const HEADLESS_API_VERSION = '1' as const;

export type HeadlessSurfaceId = 'chronos';
export type HeadlessViewerRole = 'readonly' | 'localadmin';
export type HeadlessOperationEffect = 'read' | 'write';

export interface HeadlessJsonSchema {
  type?: string;
  properties?: Record<string, HeadlessJsonSchema>;
  required?: string[];
  enum?: readonly string[];
  items?: HeadlessJsonSchema;
  additionalProperties?: boolean;
  description?: string;
}

export interface HeadlessViewerScope {
  role: HeadlessViewerRole;
  principal_id?: string;
  tenant_slugs: string[] | 'all';
  organization_ids: string[] | 'all';
  project_ids: string[] | 'all';
  tier_access: string[];
}

export interface HeadlessOperationDescriptor {
  operation_id: string;
  resource: string;
  method: 'GET' | 'POST';
  path: string;
  description: string;
  effect: HeadlessOperationEffect;
  required_role: HeadlessViewerRole;
  input_schema: HeadlessJsonSchema;
  output_schema: HeadlessJsonSchema;
  a2ui_projection: boolean;
}

export interface HeadlessResourceDescriptor {
  resource: string;
  description: string;
  query_path: string;
  a2ui_path?: string;
}

export interface HeadlessApiManifest {
  api_version: typeof HEADLESS_API_VERSION;
  surface: HeadlessSurfaceId;
  resources: HeadlessResourceDescriptor[];
  operations: HeadlessOperationDescriptor[];
}

export interface HeadlessApiEnvelope<T> {
  ok: true;
  api_version: typeof HEADLESS_API_VERSION;
  surface: HeadlessSurfaceId;
  resource: string;
  generated_at: string;
  scope: HeadlessViewerScope;
  available_operations: string[];
  data: T;
}

const EMPTY_OBJECT_SCHEMA: HeadlessJsonSchema = {
  type: 'object',
  additionalProperties: false,
};

export const CHRONOS_HEADLESS_OPERATIONS: readonly HeadlessOperationDescriptor[] = [
  {
    operation_id: 'chronos.operator_home.read',
    resource: 'operator-home',
    method: 'GET',
    path: '/api/headless/operator-home',
    description: 'Read the scoped operator home projection.',
    effect: 'read',
    required_role: 'readonly',
    input_schema: {
      type: 'object',
      properties: {
        tenant: { type: 'string' },
        organization_id: { type: 'string' },
        project_id: { type: 'string' },
        limit: { type: 'integer' },
        since: { type: 'string' },
      },
      additionalProperties: false,
    },
    output_schema: { type: 'object', description: 'OperatorHomeSummary projection.' },
    a2ui_projection: true,
  },
  {
    operation_id: 'chronos.work_items.read',
    resource: 'work-items',
    method: 'GET',
    path: '/api/headless/work-items',
    description: 'Read scoped work items with lineage and quality metadata.',
    effect: 'read',
    required_role: 'readonly',
    input_schema: {
      type: 'object',
      properties: {
        tenant: { type: 'string' },
        organization_id: { type: 'string' },
        project_id: { type: 'string' },
        mission_id: { type: 'string' },
        scope: { type: 'string' },
        view: { type: 'string' },
      },
      additionalProperties: false,
    },
    output_schema: { type: 'object', description: 'WorkVisibilityProjection.' },
    a2ui_projection: false,
  },
  {
    operation_id: 'chronos.collaboration.read',
    resource: 'collaboration',
    method: 'GET',
    path: '/api/headless/collaboration',
    description: 'Read the tenant-scoped collaboration projection.',
    effect: 'read',
    required_role: 'readonly',
    input_schema: {
      type: 'object',
      properties: {
        tenant: { type: 'string' },
        mission: { type: 'string' },
        organization: { type: 'string' },
        project: { type: 'string' },
        task: { type: 'string' },
        session: { type: 'string' },
        scope_kind: { type: 'string' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    output_schema: { type: 'object', description: 'AgentCollaborationProjection.' },
    a2ui_projection: false,
  },
  {
    operation_id: 'chronos.work_items.update_status',
    resource: 'work-items',
    method: 'POST',
    path: '/api/headless/operations/work-items/status',
    description: 'Update one work item status through the localadmin authority.',
    effect: 'write',
    required_role: 'localadmin',
    input_schema: {
      type: 'object',
      properties: {
        item_id: { type: 'string' },
        status: {
          type: 'string',
          enum: ['backlog', 'ready', 'in_progress', 'blocked', 'review', 'done', 'archived'],
        },
      },
      required: ['item_id', 'status'],
      additionalProperties: false,
    },
    output_schema: { type: 'object', description: 'Updated WorkItem.' },
    a2ui_projection: false,
  },
];

export function buildChronosHeadlessManifest(): HeadlessApiManifest {
  return {
    api_version: HEADLESS_API_VERSION,
    surface: 'chronos',
    resources: [
      {
        resource: 'operator-home',
        description: 'Operator summary, attention queue, approvals, and next action.',
        query_path: '/api/headless/operator-home',
        a2ui_path: '/api/headless/a2ui/operator-home',
      },
      {
        resource: 'work-items',
        description: 'Scoped work items with canonical context lineage.',
        query_path: '/api/headless/work-items',
      },
      {
        resource: 'collaboration',
        description: 'Tenant-scoped human and agent collaboration evidence.',
        query_path: '/api/headless/collaboration',
      },
    ],
    operations: CHRONOS_HEADLESS_OPERATIONS.map((operation) => ({
      ...operation,
      input_schema: { ...operation.input_schema },
      output_schema: { ...operation.output_schema },
    })),
  };
}

export function availableHeadlessOperationIds(
  role: HeadlessViewerRole,
  manifest: HeadlessApiManifest = buildChronosHeadlessManifest()
): string[] {
  return manifest.operations
    .filter((operation) => role === 'localadmin' || operation.required_role === 'readonly')
    .map((operation) => operation.operation_id);
}

export function createHeadlessEnvelope<T>(input: {
  resource: string;
  data: T;
  scope: HeadlessViewerScope;
  generatedAt?: string;
  manifest?: HeadlessApiManifest;
}): HeadlessApiEnvelope<T> {
  const manifest = input.manifest || buildChronosHeadlessManifest();
  return {
    ok: true,
    api_version: HEADLESS_API_VERSION,
    surface: 'chronos',
    resource: input.resource,
    generated_at: input.generatedAt || new Date().toISOString(),
    scope: input.scope,
    available_operations: availableHeadlessOperationIds(input.scope.role, manifest),
    data: input.data,
  };
}

export const HEADLESS_EMPTY_OBJECT_SCHEMA = EMPTY_OBJECT_SCHEMA;
