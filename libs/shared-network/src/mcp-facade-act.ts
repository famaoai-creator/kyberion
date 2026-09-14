/**
 * MCP facade — act band: allowlisted actuator.invoke tool.
 *
 * Extracted from mcp-server-engine.ts (kyberion.actuator.invoke) so the
 * engine stays under the max-file-lines gate. The engine still owns
 * registration/governance plumbing (registerGovernedTool, ensureMcpApproval)
 * and injects it here — see
 * knowledge/product/architecture/mcp-facade-model.md for the band model.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveMcpRequestContext } from '@agent/core/mcp-request-context';
import { formatWireError } from '@agent/core/wire-error';
import { invokeAllowlistedActuator, readActuatorInvokeAllowlist } from './mcp-actuator-invoke.js';
import type { EnsureMcpApproval, RegisterGovernedTool, ToolCatalog } from './mcp-server-engine.js';

/** Register the act-band kyberion.actuator.invoke tool on `server`. */
export function registerMcpFacadeActTools(params: {
  server: McpServer;
  catalog: ToolCatalog;
  registerGovernedTool: RegisterGovernedTool;
  ensureMcpApproval: EnsureMcpApproval;
}): void {
  const { server, catalog, registerGovernedTool, ensureMcpApproval } = params;

  // ── kyberion.actuator.invoke (act band — allowlisted; default dry_run) ────
  registerGovernedTool(
    server,
    catalog,
    'kyberion.actuator.invoke',
    'Invoke an allowlisted actuator op. Default mode is dry_run; live requires operator role.',
    {
      actuator: z.string().min(1).describe('Actuator id (e.g. file-actuator)'),
      op: z.string().min(1).describe('Actuator op (e.g. pipeline, preset)'),
      params: z
        .record(z.string(), z.any())
        .optional()
        .describe('Op parameters (validated against actuator contract when dry_run)'),
      mode: z
        .enum(['dry_run', 'live'])
        .optional()
        .default('dry_run')
        .describe('dry_run (default) or live (operator only; allowlist execution path)'),
      tenant: z.string().optional().describe('Optional tenant scope for the request context'),
      approval_ref: z
        .string()
        .optional()
        .describe(
          'Approved request_id from kyberion.approval.list_pending for live gated operations'
        ),
    },
    async ({ actuator, op, params, mode, tenant, approval_ref }) => {
      try {
        const live = mode === 'live';
        const context = resolveMcpRequestContext({
          requested_tenant: tenant,
          require_tenant: live,
        });
        const allowlist = readActuatorInvokeAllowlist(catalog);
        const allowlistEntry = allowlist.find(
          (entry) => entry.actuator === actuator && entry.op === op
        );
        let approvalGranted = false;
        if (live && allowlistEntry?.requires_approval === true) {
          const approval = ensureMcpApproval({
            context,
            approvalRef: approval_ref,
            payload: {
              operation: 'actuator.invoke',
              actuator,
              op,
              params: params ?? {},
              tenant: context.scope.tenant_slug,
            },
            effectBinding: `actuator.invoke:${actuator}:${op}`,
            title: `Invoke actuator '${actuator}:${op}'`,
            summary: `MCP caller '${context.principal}' requested a live actuator operation.`,
            details: JSON.stringify(params ?? {}),
          });
          if (!approval.allowed) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    { status: approval.status, request_id: approval.request_id },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          approvalGranted = true;
        }
        const result = await invokeAllowlistedActuator({
          actuator,
          op,
          params: params ?? {},
          mode: live ? 'live' : 'dry_run',
          allowlist,
          callerRole: context.caller_role,
          approvalGranted,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: formatWireError(err, 'Actuator invoke failed') },
          ],
          isError: true,
        };
      }
    }
  );
}
