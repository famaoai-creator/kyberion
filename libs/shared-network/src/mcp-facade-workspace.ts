/**
 * MCP facade — workspace band: the shared surface operation registry.
 *
 * Every operation in libs/core/surface/surface-operation-registry.ts is
 * registered here as `kyberion.<operation id>`, so an MCP client and the
 * unified shell's HTTP `/api/v1/<domain>/<verb>` run the same handler with the
 * same viewer-scoped authorization.
 *
 * MCP has no browser session: the viewer is the server binding. With
 * `KYBERION_MCP_TENANT` / `KYBERION_TENANT` set, the caller sees that tenant
 * (confidential + public); without a binding it sees public records only.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveMcpRequestContext } from '@agent/core/mcp-request-context';
import type { SurfaceAuthorizationContext } from '@agent/core/surface/surface-authorization';
import {
  invokeSurfaceOperation,
  listSurfaceOperations,
  surfaceOperationInputShape,
} from '@agent/core/surface/surface-operation-registry';
import type { RegisterGovernedTool, ToolCatalog } from './mcp-server-engine.js';

export function mcpWorkspaceViewer(): SurfaceAuthorizationContext {
  const context = resolveMcpRequestContext();
  const tenant = context.scope.tenant_slug;
  return {
    role: 'readonly',
    tenantSlugs: tenant ? [tenant] : [],
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: tenant ? ['confidential', 'public'] : ['public'],
    principalId: context.principal,
  };
}

export function registerMcpFacadeWorkspaceTools(params: {
  server: McpServer;
  catalog: ToolCatalog;
  registerGovernedTool: RegisterGovernedTool;
}): void {
  const { server, catalog, registerGovernedTool } = params;
  for (const op of listSurfaceOperations()) {
    registerGovernedTool(
      server,
      catalog,
      `kyberion.${op.id}`,
      op.description,
      surfaceOperationInputShape(op.id),
      async (args: Record<string, unknown>) => {
        const result = invokeSurfaceOperation(op.id, args ?? {}, { viewer: mcpWorkspaceViewer() });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          ...(result.ok ? {} : { isError: true }),
        };
      }
    );
  }
}
