import { describe, expect, it } from 'vitest';
import { generateIndex, runGenerateKnowledgeIndex } from './generate_knowledge_index.js';

describe('generate_knowledge_index', () => {
  it('keeps the compatibility check API green for the current snapshot', () => {
    expect(generateIndex(true)).toBe(true);
  });

  it('uses the shared generator contract for a clean check', async () => {
    const result = await runGenerateKnowledgeIndex(['--check', '--quiet']);
    expect(result?.changed).toEqual([]);
  });
});
