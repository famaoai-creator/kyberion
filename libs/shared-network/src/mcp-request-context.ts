import { normalizeEventScope, type EventScope } from '@agent/core/event-scope';
import { baseRoleEnvText } from '@agent/core/foundation';
import { getRegisteredEnvText } from '@agent/core/foundation/env';
import { resolveClaimedNhiId } from '@agent/core/contracts/nhi-id';

export type McpCallerRole = 'operator' | 'agent' | 'cowork' | 'service' | 'unknown';

export interface McpRequestContext {
  principal: string;
  caller_role: McpCallerRole;
  nhi_id?: string;
  scope: EventScope;
}

/**
 * The identity one MCP server process runs as. Resolved from the server's own
 * environment only — never from tool arguments.
 */
export interface McpServerIdentity {
  /** Tenant binding that authorizes requests. Absent = public tier only. */
  tenant?: string;
  /**
   * Tenant recorded on the server's lifecycle receipt: `tenant`, else the
   * legacy `KYBERION_TENANT_ID`. Attribution only; it authorizes nothing.
   */
  lifecycle_tenant?: string;
  /** Name recorded as the actor of a request. */
  principal: string;
  /** Role checked against `allowed_caller_roles` in mcp-tool-catalog.json. */
  caller_role: McpCallerRole;
  /** NHI bound into request, event and approval scope. */
  nhi_id?: string;
  /** Service principal id recorded on the server's lifecycle receipt. */
  service_principal_id: string;
}

export interface McpRequestContextInput {
  requested_tenant?: string;
  requested_tier?: 'public' | 'confidential' | 'personal';
  organization_id?: string;
  project_id?: string;
  mission_id?: string;
  task_id?: string;
  require_tenant?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Enforce the caller-role contract declared by the MCP tool catalog.
 *
 * The role is resolved from the server-side binding above. A client cannot
 * promote itself by passing a role in tool arguments, and an unknown role is
 * rejected rather than treated as a permissive default.
 */
export function assertMcpCallerRole(
  context: Pick<McpRequestContext, 'caller_role'>,
  allowedRoles: readonly string[],
  toolName: string
): void {
  if (context.caller_role === 'unknown') {
    throw new Error(
      `[MCP_CALLER_ROLE_REQUIRED] server caller role is not established for ${toolName}`
    );
  }
  if (!allowedRoles.includes(context.caller_role)) {
    throw new Error(
      `[MCP_CALLER_ROLE_DENIED] caller role '${context.caller_role}' is not allowed for ${toolName}`
    );
  }
}

function clean(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function envText(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return getRegisteredEnvText(name, { env });
}

const MCP_CALLER_ROLES: readonly McpCallerRole[] = ['operator', 'agent', 'cowork', 'service'];

/** Service principal recorded when the environment names none. */
const MCP_DEFAULT_SERVICE_PRINCIPAL = 'mcp-server-cowork';

/**
 * The one owner of "which tenant / principal / caller role is this MCP server
 * running as". Every per-request context and the server's start/stop
 * lifecycle receipt read the identity here, so the two cannot drift apart.
 *
 * Precedence, first non-empty value wins:
 *
 * - `tenant`: `KYBERION_MCP_TENANT` > `KYBERION_TENANT`
 * - `lifecycle_tenant`: `KYBERION_MCP_TENANT` > `KYBERION_TENANT` >
 *   `KYBERION_TENANT_ID` (legacy)
 * - `principal`: `KYBERION_MCP_PRINCIPAL` > `KYBERION_BASE_ROLE` (retired name
 *   `KYBERION_PERSONA`) > `mcp-client`
 * - `caller_role`: `KYBERION_MCP_CALLER_ROLE` > `MISSION_ROLE`; any value other
 *   than operator / agent / cowork / service is `unknown`
 * - `nhi_id`: `KYBERION_MCP_NHI` > claimed NHI (`KYBERION_NHI_ID`, legacy
 *   `KYBERION_NHI_ACTOR`)
 * - `service_principal_id`: `KYBERION_MCP_NHI` > `KYBERION_MCP_PRINCIPAL` >
 *   `mcp-server-cowork`
 *
 * `KYBERION_TENANT_ID` labels the lifecycle receipt only. It never becomes the
 * request binding: a server started with only that variable serves the public
 * tier. The base role names an authority bundle, not a service, so it is never
 * the service principal.
 *
 * The first variable that is set decides a field even when its value is
 * unusable: a whitespace-only `KYBERION_MCP_TENANT` leaves the server unbound,
 * and an unrecognised `KYBERION_MCP_CALLER_ROLE` is `unknown` — neither falls
 * through to the next variable. An empty value counts as not set.
 */
export function resolveMcpServerIdentity(env: NodeJS.ProcessEnv = process.env): McpServerIdentity {
  const mcpTenant = envText(env, 'KYBERION_MCP_TENANT');
  const mcpPrincipal = envText(env, 'KYBERION_MCP_PRINCIPAL');
  const mcpNhi = envText(env, 'KYBERION_MCP_NHI');
  const tenant = clean(mcpTenant || envText(env, 'KYBERION_TENANT'));
  const lifecycleTenant = clean(
    mcpTenant || envText(env, 'KYBERION_TENANT') || envText(env, 'KYBERION_TENANT_ID')
  );
  const nhiId = clean(
    mcpNhi ||
      resolveClaimedNhiId(
        getRegisteredEnvText('KYBERION_NHI_ID', { env, preserveEmpty: true }),
        envText(env, 'KYBERION_NHI_ACTOR')
      )
  );
  const callerRole = clean(
    envText(env, 'KYBERION_MCP_CALLER_ROLE') || envText(env, 'MISSION_ROLE')
  ) as McpCallerRole | undefined;
  return {
    ...(tenant ? { tenant } : {}),
    ...(lifecycleTenant ? { lifecycle_tenant: lifecycleTenant } : {}),
    principal: clean(mcpPrincipal || baseRoleEnvText(env)) || 'mcp-client',
    caller_role: callerRole && MCP_CALLER_ROLES.includes(callerRole) ? callerRole : 'unknown',
    ...(nhiId ? { nhi_id: nhiId } : {}),
    service_principal_id: clean(mcpNhi || mcpPrincipal) || MCP_DEFAULT_SERVICE_PRINCIPAL,
  };
}

/**
 * Resolve MCP request identity from the server-side binding
 * ({@link resolveMcpServerIdentity}). A tenant supplied by a client can only
 * narrow an existing binding; it can never establish authorization by itself.
 */
export function resolveMcpRequestContext(input: McpRequestContextInput = {}): McpRequestContext {
  const identity = resolveMcpServerIdentity(input.env || process.env);
  const boundTenant = identity.tenant;
  const requestedTenant = clean(input.requested_tenant);
  if (requestedTenant && !boundTenant) {
    throw new Error('[MCP_SCOPE_REQUIRED] client tenant cannot establish authorization');
  }
  if (requestedTenant && boundTenant && requestedTenant !== boundTenant) {
    throw new Error(
      `[MCP_SCOPE_MISMATCH] requested tenant '${requestedTenant}' is outside server binding '${boundTenant}'`
    );
  }
  const tenant = boundTenant;
  if (input.require_tenant && !tenant) {
    throw new Error('[MCP_SCOPE_REQUIRED] this MCP operation requires a server-bound tenant');
  }
  const tier = input.requested_tier || (tenant ? 'confidential' : 'public');
  if (tier !== 'public' && !tenant) {
    throw new Error(`[MCP_SCOPE_REQUIRED] tier '${tier}' requires a server-bound tenant`);
  }

  const nhiId = identity.nhi_id;
  const scope = normalizeEventScope({
    scope_kind: input.task_id
      ? 'task'
      : input.mission_id
        ? 'mission'
        : tenant
          ? 'tenant'
          : 'system',
    tier,
    ...(tenant ? { tenant_slug: tenant } : {}),
    ...(clean(input.organization_id) ? { organization_id: clean(input.organization_id) } : {}),
    ...(clean(input.project_id) ? { project_id: clean(input.project_id) } : {}),
    ...(clean(input.mission_id) ? { mission_id: clean(input.mission_id) } : {}),
    ...(clean(input.task_id) ? { task_id: clean(input.task_id) } : {}),
    ...(nhiId ? { nhi_id: nhiId } : {}),
  });
  return {
    principal: identity.principal,
    caller_role: identity.caller_role,
    ...(nhiId ? { nhi_id: nhiId } : {}),
    scope,
  };
}
