import {
  authorizeSurfaceOperation,
  type SurfaceAuthorizationContext,
  type SurfaceAuthorizationRole,
  type SurfacePermission,
} from './surface-authorization.js';

/**
 * Framework-neutral contracts for surface APIs.
 *
 * This is deliberately separate from A2UI: headless consumers need stable
 * data/operation semantics even when they do not render a Kyberion surface.
 */

export const HEADLESS_API_VERSION = '1' as const;

export type HeadlessSurfaceId = 'chronos' | 'concierge' | 'presence-studio' | 'computer-surface';
export type HeadlessViewerRole = SurfaceAuthorizationRole;
export type HeadlessOperationPermission = SurfacePermission;
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
  required_permissions: readonly HeadlessOperationPermission[];
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
    required_permissions: ['surface.headless.read'],
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
    required_permissions: ['surface.headless.read'],
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
    required_permissions: ['surface.headless.read'],
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
    required_permissions: ['surface.headless.write'],
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

export const COMPUTER_SURFACE_OPERATIONS: readonly HeadlessOperationDescriptor[] = [
  {
    operation_id: 'computer_surface.manifest.read',
    resource: 'headless-manifest',
    method: 'GET',
    path: '/api/headless/manifest',
    description: 'Read the Computer Surface operation manifest filtered by viewer role.',
    effect: 'read',
    required_role: 'readonly',
    required_permissions: ['surface.headless.read'],
    input_schema: EMPTY_OBJECT_SCHEMA,
    output_schema: { type: 'object', description: 'Computer Surface headless manifest.' },
    a2ui_projection: false,
  },
  {
    operation_id: 'computer_surface.identity.read',
    resource: 'identity',
    method: 'GET',
    path: '/api/identity',
    description: 'Read the local identity projection available to the resolved viewer.',
    effect: 'read',
    required_role: 'localadmin',
    required_permissions: ['surface.headless.read'],
    input_schema: EMPTY_OBJECT_SCHEMA,
    output_schema: { type: 'object', description: 'Identity and onboarding projection.' },
    a2ui_projection: false,
  },
  {
    operation_id: 'computer_surface.state.read',
    resource: 'surface-state',
    method: 'GET',
    path: '/api/state',
    description: 'Read the latest A2UI state mirrored by Computer Surface.',
    effect: 'read',
    required_role: 'readonly',
    required_permissions: ['surface.headless.read'],
    input_schema: EMPTY_OBJECT_SCHEMA,
    output_schema: { type: 'object', description: 'Latest Computer Surface state.' },
    a2ui_projection: true,
  },
  {
    operation_id: 'computer_surface.stream.read',
    resource: 'surface-stream',
    method: 'GET',
    path: '/api/stream',
    description: 'Subscribe to the scoped Computer Surface state stream.',
    effect: 'read',
    required_role: 'readonly',
    required_permissions: ['surface.headless.read'],
    input_schema: EMPTY_OBJECT_SCHEMA,
    output_schema: { type: 'string', description: 'Server-sent Computer Surface state events.' },
    a2ui_projection: true,
  },
  {
    operation_id: 'computer_surface.os_control_plane.read',
    resource: 'os-control-plane',
    method: 'GET',
    path: '/api/os/control-plane',
    description: 'Read the tenant-scoped, read-only OS control-plane projection.',
    effect: 'read',
    required_role: 'readonly',
    required_permissions: ['surface.headless.read'],
    input_schema: {
      type: 'object',
      properties: { mission_id: { type: 'string' } },
      additionalProperties: false,
    },
    output_schema: { type: 'object', description: 'Held actions and observations projection.' },
    a2ui_projection: true,
  },
  {
    operation_id: 'computer_surface.a2ui.dispatch',
    resource: 'a2ui-dispatch',
    method: 'POST',
    path: '/a2ui/dispatch',
    description: 'Apply an A2UI state update to the local Computer Surface mirror.',
    effect: 'write',
    required_role: 'localadmin',
    required_permissions: ['surface.headless.write'],
    input_schema: { type: 'array', description: 'A2UI messages.' },
    output_schema: { type: 'object', description: 'Applied message count.' },
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

export function buildComputerSurfaceManifest(): HeadlessApiManifest {
  return {
    api_version: HEADLESS_API_VERSION,
    surface: 'computer-surface',
    resources: [
      {
        resource: 'headless-manifest',
        description: 'Viewer-filtered operation and resource manifest.',
        query_path: '/api/headless/manifest',
      },
      {
        resource: 'identity',
        description: 'Viewer-scoped local identity and onboarding projection.',
        query_path: '/api/identity',
      },
      {
        resource: 'surface-state',
        description: 'Latest A2UI state mirrored by Computer Surface.',
        query_path: '/api/state',
      },
      {
        resource: 'surface-stream',
        description: 'Scoped live state stream.',
        query_path: '/api/stream',
      },
      {
        resource: 'os-control-plane',
        description: 'Read-only held-action and observation projection.',
        query_path: '/api/os/control-plane',
      },
      {
        resource: 'a2ui-dispatch',
        description: 'Governed A2UI state update transport.',
        query_path: '/a2ui/dispatch',
      },
    ],
    operations: COMPUTER_SURFACE_OPERATIONS.map((operation) => ({
      ...operation,
      input_schema: { ...operation.input_schema },
      output_schema: { ...operation.output_schema },
    })),
  };
}

export function availableHeadlessOperationIds(
  viewer: HeadlessViewerRole | SurfaceAuthorizationContext,
  manifest: HeadlessApiManifest = buildChronosHeadlessManifest()
): string[] {
  const context: SurfaceAuthorizationContext =
    typeof viewer === 'string'
      ? {
          role: viewer,
          tenantSlugs: 'all',
          organizationIds: 'all',
          projectIds: 'all',
          tierAccess: ['personal', 'confidential', 'public'],
        }
      : viewer;
  return manifest.operations
    .filter(
      (operation) =>
        authorizeSurfaceOperation({
          context,
          operation: {
            operationId: operation.operation_id,
            effect: operation.effect,
            requiredRole: operation.required_role,
            requiredPermissions: operation.required_permissions,
          },
        }).allowed
    )
    .map((operation) => operation.operation_id);
}

export function filterHeadlessManifestForViewer(
  viewer: HeadlessViewerRole | SurfaceAuthorizationContext,
  manifest: HeadlessApiManifest
): HeadlessApiManifest {
  const context: SurfaceAuthorizationContext =
    typeof viewer === 'string'
      ? {
          role: viewer,
          tenantSlugs: 'all',
          organizationIds: 'all',
          projectIds: 'all',
          tierAccess: ['personal', 'confidential', 'public'],
        }
      : viewer;
  return {
    ...manifest,
    operations: manifest.operations.filter(
      (operation) =>
        authorizeSurfaceOperation({
          context,
          operation: {
            operationId: operation.operation_id,
            effect: operation.effect,
            requiredRole: operation.required_role,
            requiredPermissions: operation.required_permissions,
          },
        }).allowed
    ),
  };
}

export function createHeadlessEnvelope<T>(input: {
  surface?: HeadlessSurfaceId;
  resource: string;
  data: T;
  scope: HeadlessViewerScope;
  generatedAt?: string;
  manifest?: HeadlessApiManifest;
  authorizationContext?: SurfaceAuthorizationContext;
}): HeadlessApiEnvelope<T> {
  const manifest = input.manifest || buildChronosHeadlessManifest();
  return {
    ok: true,
    api_version: HEADLESS_API_VERSION,
    surface: input.surface || 'chronos',
    resource: input.resource,
    generated_at: input.generatedAt || new Date().toISOString(),
    scope: input.scope,
    available_operations: availableHeadlessOperationIds(
      input.authorizationContext || input.scope.role,
      manifest
    ),
    data: input.data,
  };
}

export const HEADLESS_EMPTY_OBJECT_SCHEMA = EMPTY_OBJECT_SCHEMA;
