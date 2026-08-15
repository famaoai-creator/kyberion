import { normalizeEventScope, type EventScope } from './event-scope.js';

export type McpCallerRole = 'operator' | 'agent' | 'cowork' | 'service' | 'unknown';

export interface McpRequestContext {
  principal: string;
  caller_role: McpCallerRole;
  nhi_id?: string;
  scope: EventScope;
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

function clean(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

/**
 * Resolve MCP request identity from the server-side binding.
 * A tenant supplied by a client can only narrow an existing binding; it can
 * never establish authorization by itself.
 */
export function resolveMcpRequestContext(input: McpRequestContextInput = {}): McpRequestContext {
  const env = input.env || process.env;
  const boundTenant = clean(env.KYBERION_MCP_TENANT || env.KYBERION_TENANT);
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

  const nhiId = clean(env.KYBERION_MCP_NHI || env.KYBERION_NHI_ACTOR);
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
  const callerRole = clean(env.KYBERION_MCP_CALLER_ROLE || env.MISSION_ROLE) as
    McpCallerRole | undefined;
  return {
    principal: clean(env.KYBERION_MCP_PRINCIPAL || env.KYBERION_PERSONA) || 'mcp-client',
    caller_role:
      callerRole && ['operator', 'agent', 'cowork', 'service'].includes(callerRole)
        ? callerRole
        : 'unknown',
    ...(nhiId ? { nhi_id: nhiId } : {}),
    scope,
  };
}
