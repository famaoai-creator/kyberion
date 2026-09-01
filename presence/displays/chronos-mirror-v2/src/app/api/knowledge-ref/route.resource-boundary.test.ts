import { describe, expect, it } from 'vitest';

import { resolveSafeKnowledgeReferencePath } from './route';

describe('knowledge-ref resource boundary', () => {
  it('rejects a missing or unsafe reference before reading it', () => {
    expect(resolveSafeKnowledgeReferencePath('knowledge/public/does-not-exist.md')).toBeNull();
    expect(
      resolveSafeKnowledgeReferencePath('knowledge/public/../../active/secrets.json')
    ).toBeNull();
  });
});
