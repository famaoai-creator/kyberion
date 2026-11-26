/**
 * MCP facade — session-scoped memory-loop tools (`recall`, `cite`, `capture_correction`).
 *
 * Extracted from mcp-server-engine.ts so the engine stays under max-file-lines.
 * All three tools delegate to `@agent/core/knowledge/memory-loop-session` using
 * server-resolved `context.scope` (clients cannot widen tenant or tier).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatWireError } from '@agent/core/contracts/wire-error';
import {
  captureSessionCorrection,
  citePromotedKnowledgeForSession,
  recallPromotedKnowledgeForSession,
} from '@agent/core/knowledge';
import type { MemoryScopeEnvelope } from '@agent/core/knowledge/memory-scope';
import type { McpRequestContext } from './mcp-request-context.js';
import type { RegisterGovernedTool, ToolCatalog } from './mcp-server-engine.js';

function resolveMcpMemoryScope(context: McpRequestContext): MemoryScopeEnvelope {
  const ownerNhi = context.nhi_id?.trim() || context.principal?.trim();
  return {
    ...context.scope,
    ...(context.scope.tier === 'personal' && ownerNhi ? { owner_nhi: ownerNhi } : {}),
  };
}

/** Register kyberion.knowledge.{recall,cite,capture_correction} on `server`. */
export function registerMcpFacadeMemoryLoopTools(params: {
  server: McpServer;
  catalog: ToolCatalog;
  registerGovernedTool: RegisterGovernedTool;
}): void {
  const { server, catalog, registerGovernedTool } = params;

  registerGovernedTool(
    server,
    catalog,
    'kyberion.knowledge.recall',
    'Recall relevant promoted knowledge records for an interactive MCP session and record scoped delivery telemetry.',
    {
      topic: z.string().min(1).describe('Task or topic to match against promoted knowledge'),
      session_id: z
        .string()
        .min(1)
        .describe('Interactive session identifier used to correlate recall and cite calls'),
      limit: z.number().int().min(1).max(10).optional().default(5),
      min_score: z.number().min(0).max(1).optional().default(0.05),
    },
    async ({ topic, session_id, limit, min_score }, context) => {
      try {
        const result = await recallPromotedKnowledgeForSession({
          topic,
          sessionId: session_id,
          scope: resolveMcpMemoryScope(context),
          recipientKind: 'mcp_session',
          ...(typeof limit === 'number' ? { limit } : {}),
          ...(typeof min_score === 'number' ? { minScore: min_score } : {}),
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: formatWireError(err, 'Knowledge recall failed') },
          ],
          isError: true,
        };
      }
    }
  );

  registerGovernedTool(
    server,
    catalog,
    'kyberion.knowledge.cite',
    'Record used, not_used, or missing_topics usage feedback for promoted knowledge delivered to an interactive MCP session.',
    {
      session_id: z.string().min(1).describe('Session identifier matching the prior recall call'),
      used: z.array(z.string().min(1)).default([]).describe('Delivered knowledge paths applied'),
      not_used: z.array(z.string().min(1)).optional().default([]),
      missing_topics: z.array(z.string().min(1)).optional().default([]),
      result_id: z.string().optional().describe('Optional idempotency key for this citation'),
    },
    async ({ session_id, used, not_used, missing_topics, result_id }, context) => {
      try {
        const result = citePromotedKnowledgeForSession({
          sessionId: session_id,
          used: used ?? [],
          notUsed: not_used ?? [],
          missingTopics: missing_topics ?? [],
          scope: resolveMcpMemoryScope(context),
          ...(typeof result_id === 'string' && result_id.trim()
            ? { resultId: result_id.trim() }
            : {}),
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: formatWireError(err, 'Knowledge cite failed') }],
          isError: true,
        };
      }
    }
  );

  registerGovernedTool(
    server,
    catalog,
    'kyberion.knowledge.capture_correction',
    'Capture a conversational rule or preference correction (IL-05) with secret/PII scrubbing inside the resolved scope.',
    {
      text: z
        .string()
        .min(1)
        .describe('Conversational utterance expressing a standing preference or boundary'),
      session_id: z.string().min(1).describe('Session correlation identifier'),
    },
    async ({ text, session_id }, context) => {
      try {
        const result = captureSessionCorrection({
          text,
          sessionId: session_id,
          scope: resolveMcpMemoryScope(context),
          surface: 'mcp',
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: formatWireError(err, 'Correction capture failed') },
          ],
          isError: true,
        };
      }
    }
  );
}
