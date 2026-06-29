import { beforeEach, describe, expect, it, vi } from 'vitest';

// The dynamic import inside gatherImprovementHints resolves to this mocked module.
vi.mock('./src/knowledge-index.js', () => ({
  buildKnowledgeIndex: vi.fn(async () => ({ hints: [] })),
  queryKnowledgeHybrid: vi.fn(async () => [
    { topic: 'flaky-deploy', hint: 'add a readiness probe before smoke tests', confidence: 0.82, tags: ['deploy'] },
  ]),
}));

import { gatherImprovementHints } from './intent-resolution.js';
import { buildKnowledgeIndex, queryKnowledgeHybrid } from './src/knowledge-index.js';

const mockBuild = vi.mocked(buildKnowledgeIndex);
const mockQuery = vi.mocked(queryKnowledgeHybrid);

describe('gatherImprovementHints — improvement-loop (④→①) closure', () => {
  beforeEach(() => {
    mockBuild.mockClear();
    mockQuery.mockClear();
  });

  it('returns mapped hints (topic/hint/confidence) for a non-empty intent', async () => {
    const hints = await gatherImprovementHints('deploy the web app');
    expect(hints).toEqual([
      { topic: 'flaky-deploy', hint: 'add a readiness probe before smoke tests', confidence: 0.82 },
    ]);
    expect(mockBuild).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(expect.anything(), 'deploy the web app', { maxResults: 5 });
  });

  it('honors maxResults', async () => {
    await gatherImprovementHints('x y', { maxResults: 3 });
    expect(mockQuery).toHaveBeenCalledWith(expect.anything(), 'x y', { maxResults: 3 });
  });

  it('returns [] for an empty intent without touching the knowledge index', async () => {
    const hints = await gatherImprovementHints('   ');
    expect(hints).toEqual([]);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('is non-blocking: returns [] when the knowledge subsystem throws', async () => {
    mockBuild.mockRejectedValueOnce(new Error('index unavailable'));
    const hints = await gatherImprovementHints('anything');
    expect(hints).toEqual([]);
  });
});
