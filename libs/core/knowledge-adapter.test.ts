import { describe, expect, it } from 'vitest';
import {
  listKnowledgeAdapters,
  registerKnowledgeAdapter,
  resolveKnowledgeAdapter,
} from './knowledge-adapter.js';

describe('knowledge adapter seam', () => {
  it('registers and resolves adapters without adapter-specific dispatch', () => {
    const dispose = registerKnowledgeAdapter({ id: 'test-memory-adapter' });
    try {
      expect(resolveKnowledgeAdapter('test-memory-adapter').id).toBe('test-memory-adapter');
      expect(listKnowledgeAdapters().some((adapter) => adapter.id === 'test-memory-adapter')).toBe(
        true
      );
    } finally {
      dispose();
    }
  });

  it('rejects ambiguous default selection', () => {
    const first = registerKnowledgeAdapter({ id: 'test-memory-a' });
    const second = registerKnowledgeAdapter({ id: 'test-memory-b' });
    try {
      expect(() => resolveKnowledgeAdapter()).toThrow(/ambiguous/i);
    } finally {
      second();
      first();
    }
  });
});
