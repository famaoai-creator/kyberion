import { describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('knowledge CLI resource boundary', () => {
  it('validates proposal reads and generated knowledge writes', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/knowledge.ts'), { encoding: 'utf8' })
    );

    expect(source).toContain('assertSafeRepositoryPath(pathResolver.rootResolve(proposalPathArg))');
    expect(source).toContain('loadKnowledgeRankingWeightProposal(proposalPath)');
    expect(source).toContain('assertSafeRepositoryPath(pathResolver.knowledge(relativePath), {');
  });
});
