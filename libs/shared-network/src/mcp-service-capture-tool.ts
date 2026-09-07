import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeServicePreset } from '@agent/core/service-engine';
import { assertServiceCaptureOperation } from '@agent/core/service-harness';
import { formatWireError } from '@agent/core/wire-error';

type GovernedToolRegistrar<C> = (
  server: McpServer,
  catalog: C,
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: {
    service_id: string;
    action: string;
    params?: Record<string, unknown>;
  }) => Promise<unknown>
) => void;

/** Register the capture-only MCP service tool (writes stay on `kyberion.service.actuate`). */
export function registerKyberionServiceCaptureTool<C>(
  server: McpServer,
  catalog: C,
  registerGovernedTool: GovernedToolRegistrar<C>
): void {
  registerGovernedTool(
    server,
    catalog,
    'kyberion.service.capture',
    'Execute a capture/read Kyberion service preset. Writes are rejected.',
    {
      service_id: z.string().describe('The ID of the service (e.g. "github")'),
      action: z
        .string()
        .describe('A capture/read operation (e.g. "list_issues", "list_pulls", "list_reviews")'),
      params: z
        .record(z.string(), z.any())
        .optional()
        .describe('Parameters for the operation (path vars and query)'),
    },
    async ({ service_id, action, params }) => {
      try {
        assertServiceCaptureOperation(service_id, action);
        const result = await executeServicePreset(service_id, action, params ?? {}, 'secret-guard');
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: formatWireError(err, 'Service capture failed') },
          ],
          isError: true,
        };
      }
    }
  );
}
