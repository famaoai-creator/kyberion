import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCurrentScope } from '@agent/core/scope-context';

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

import { main, resolveCliSessionScope } from './knowledge.js';

describe('knowledge CLI memory-loop subcommands', () => {
  let prevTenant: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    prevTenant = process.env.KYBERION_TENANT;
    delete process.env.KYBERION_TENANT;
    resetCurrentScope();
  });

  afterEach(() => {
    if (prevTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = prevTenant;
    resetCurrentScope();
  });

  it('routes recall, cite, and capture-correction to the shared memory-loop session facade', async () => {
    mocks.recallPromotedKnowledgeForSession.mockResolvedValueOnce({
      session_id: 'cli-test-1',
      mission_id: 'session:cli-test-1',
      delivered_count: 1,
      entries: [],
    });
    await main(['recall', '--topic', 'ci checks', '--session', 'cli-test-1', '--limit', '3']);
    expect(mocks.recallPromotedKnowledgeForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'ci checks',
        sessionId: 'cli-test-1',
        limit: 3,
        recipientKind: 'cli_session',
      })
    );

    mocks.citePromotedKnowledgeForSession.mockReturnValueOnce({
      session_id: 'cli-test-1',
      mission_id: 'session:cli-test-1',
      usage_updated: true,
      used_paths: ['knowledge/product/evolution/patterns/generated/mem-1.md'],
      rejected_used_paths: [],
      promotion_candidate_ids: [],
    });
    await main([
      'cite',
      '--used',
      'knowledge/product/evolution/patterns/generated/mem-1.md',
      '--not-used',
      'knowledge/product/evolution/patterns/generated/mem-2.md',
      '--session',
      'cli-test-1',
    ]);
    expect(mocks.citePromotedKnowledgeForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'cli-test-1',
        used: ['knowledge/product/evolution/patterns/generated/mem-1.md'],
        notUsed: ['knowledge/product/evolution/patterns/generated/mem-2.md'],
      })
    );

    mocks.captureSessionCorrection.mockReturnValueOnce({
      captured: true,
      reason: 'captured',
      detection: { matched: true, category: 'style_format', confidence: 'high' },
    });
    await main([
      'capture-correction',
      '--text',
      '今後は簡潔にまとめて',
      '--session',
      'cli-test-1',
      '--tenant',
      'acme',
    ]);
    expect(mocks.captureSessionCorrection).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '今後は簡潔にまとめて',
        sessionId: 'cli-test-1',
        surface: 'cli',
        scope: expect.objectContaining({ tier: 'confidential', tenant_slug: 'acme' }),
      })
    );
  });

  it('rejects --tenant overrides that mismatch an already-bound tenant scope', async () => {
    process.env.KYBERION_TENANT = 'tenant-a';
    resetCurrentScope();
    expect(() =>
      resolveCliSessionScope(['recall', '--topic', 'ci', '--tenant', 'tenant-b'])
    ).toThrow('[SCOPE_CONTEXT_MISMATCH]');
    const prevExitCode = process.exitCode;
    await main(['recall', '--topic', 'ci', '--tenant', 'tenant-b']);
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExitCode;
    expect(mocks.recallPromotedKnowledgeForSession).not.toHaveBeenCalled();
  });
});
