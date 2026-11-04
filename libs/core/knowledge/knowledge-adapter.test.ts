import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('knowledge-adapter saved seam default', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('resolves the saved default when several adapters are registered', () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'knowledge-adapter=test-memory-b');
    const first = registerKnowledgeAdapter({ id: 'test-memory-a' });
    const second = registerKnowledgeAdapter({ id: 'test-memory-b' });
    try {
      expect(resolveKnowledgeAdapter().id).toBe('test-memory-b');
      expect(resolveKnowledgeAdapter('test-memory-a').id).toBe('test-memory-a');
    } finally {
      second();
      first();
    }
  });

  it('an unregistered saved default keeps the seam rule (single adapter / ambiguous)', () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'knowledge-adapter=not-registered');
    const first = registerKnowledgeAdapter({ id: 'test-memory-a' });
    try {
      expect(resolveKnowledgeAdapter().id).toBe('test-memory-a');
      const second = registerKnowledgeAdapter({ id: 'test-memory-b' });
      try {
        expect(() => resolveKnowledgeAdapter()).toThrow(/ambiguous/i);
      } finally {
        second();
      }
    } finally {
      first();
    }
  });
});
