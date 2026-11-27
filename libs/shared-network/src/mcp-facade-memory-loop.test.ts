import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recallPromotedKnowledgeForSession: vi.fn(),
  citePromotedKnowledgeForSession: vi.fn(),
  captureSessionCorrection: vi.fn(),
}));

vi.mock('@agent/core/knowledge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/knowledge')>();
  return {
    ...actual,
    recallPromotedKnowledgeForSession: mocks.recallPromotedKnowledgeForSession,
    citePromotedKnowledgeForSession: mocks.citePromotedKnowledgeForSession,
    captureSessionCorrection: mocks.captureSessionCorrection,
  };
});

import { registerMcpFacadeMemoryLoopTools } from './mcp-facade-memory-loop.js';
import type { McpRequestContext } from './mcp-request-context.js';
import type { RegisterGovernedTool } from './mcp-server-engine.js';

type ToolResponse = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>, ctx: McpRequestContext) => Promise<ToolResponse>;

describe('mcp-facade-memory-loop', () => {
  const handlers = new Map<string, ToolHandler>();

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    const registerGovernedTool = ((
      _server: unknown,
      _catalog: unknown,
      name: string,
      _desc: string,
      _schema: Record<string, unknown>,
      handler: ToolHandler
    ) => {
      handlers.set(name, handler);
    }) as unknown as RegisterGovernedTool;
    registerMcpFacadeMemoryLoopTools({
      server: {} as never,
      catalog: {} as never,
      registerGovernedTool,
    });
  });

  it('registers recall, cite, and capture_correction using server-resolved scope', async () => {
    const context: McpRequestContext = {
      principal: 'operator@acme',
      caller_role: 'operator',
      nhi_id: 'nhi-op-1',
      scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'acme' },
    };

    mocks.recallPromotedKnowledgeForSession.mockResolvedValueOnce({
      session_id: 'mcp-1',
      mission_id: 'session:mcp-1',
      delivered_count: 1,
      entries: [],
    });
    const recallRes = await handlers.get('kyberion.knowledge.recall')!(
      { topic: 'guardrails', session_id: 'mcp-1', limit: 3, min_score: 0.1 },
      context
    );
    expect(recallRes.isError).toBeUndefined();
    expect(mocks.recallPromotedKnowledgeForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'guardrails',
        sessionId: 'mcp-1',
        recipientKind: 'mcp_session',
        scope: expect.objectContaining({ tier: 'confidential', tenant_slug: 'acme' }),
      })
    );

    mocks.citePromotedKnowledgeForSession.mockReturnValueOnce({
      session_id: 'mcp-1',
      mission_id: 'session:mcp-1',
      usage_updated: true,
      used_paths: ['knowledge/product/evolution/patterns/generated/mem-1.md'],
      rejected_used_paths: [],
      promotion_candidate_ids: [],
    });
    const citeRes = await handlers.get('kyberion.knowledge.cite')!(
      {
        session_id: 'mcp-1',
        used: ['knowledge/product/evolution/patterns/generated/mem-1.md'],
        not_used: [],
        missing_topics: [],
        result_id: 'res-1',
      },
      context
    );
    expect(citeRes.isError).toBeUndefined();
    expect(mocks.citePromotedKnowledgeForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'mcp-1',
        used: ['knowledge/product/evolution/patterns/generated/mem-1.md'],
        resultId: 'res-1',
        scope: expect.objectContaining({ tier: 'confidential', tenant_slug: 'acme' }),
      })
    );

    mocks.captureSessionCorrection.mockReturnValueOnce({
      captured: true,
      reason: 'captured',
      detection: { matched: true, category: 'style_format', confidence: 'high' },
    });
    const captureRes = await handlers.get('kyberion.knowledge.capture_correction')!(
      { text: '今後は結論から書いて', session_id: 'mcp-1' },
      context
    );
    expect(captureRes.isError).toBeUndefined();
    expect(mocks.captureSessionCorrection).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '今後は結論から書いて',
        sessionId: 'mcp-1',
        surface: 'mcp',
        scope: expect.objectContaining({ tier: 'confidential', tenant_slug: 'acme' }),
      })
    );
  });

  it('binds personal owner_nhi from context when scope tier is personal', async () => {
    const personalCtx: McpRequestContext = {
      principal: 'famao',
      caller_role: 'operator',
      nhi_id: 'nhi-personal-1',
      scope: { scope_kind: 'system', tier: 'personal' },
    };
    mocks.captureSessionCorrection.mockReturnValueOnce({
      captured: true,
      reason: 'captured',
      detection: { matched: true, category: 'general', confidence: 'medium' },
    });
    await handlers.get('kyberion.knowledge.capture_correction')!(
      { text: 'Next time keep responses short', session_id: 'mcp-p1' },
      personalCtx
    );
    expect(mocks.captureSessionCorrection).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({ tier: 'personal', owner_nhi: 'nhi-personal-1' }),
      })
    );
  });
});
