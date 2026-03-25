import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Mock dependencies
vi.mock('../path-resolver.js', () => ({
  knowledge: () => '/tmp/test-knowledge-base',
}));

vi.mock('../secure-io.js', () => ({
  safeExistsSync: (p: string) => fs.existsSync(p),
  safeReaddir: (p: string) => fs.readdirSync(p),
  safeReadFile: (p: string, opts: any) => fs.readFileSync(p, opts.encoding),
}));

import {
  buildKnowledgeIndex,
  queryKnowledge,
  KnowledgeHintIndex,
} from './knowledge-index.js';

const TEST_ROOT = '/tmp/test-knowledge-base';
const HINTS_DIR = path.join(TEST_ROOT, 'public/procedures/hints');

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanup() {
  if (fs.existsSync(TEST_ROOT)) {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

describe('knowledge-index', () => {
  beforeEach(() => {
    cleanup();
    ensureDir(HINTS_DIR);
  });

  afterEach(() => {
    cleanup();
  });

  describe('buildKnowledgeIndex', () => {
    it('returns a KnowledgeHintIndex with hints from procedures/hints/', async () => {
      const hints = [
        { topic: 'browser automation', hint: 'Use Playwright for web scraping', confidence: 0.9, tags: ['browser'] },
        { topic: 'file operations', hint: 'Always use secure-io', confidence: 0.8 },
      ];
      fs.writeFileSync(path.join(HINTS_DIR, 'test-hints.json'), JSON.stringify(hints));

      const index = await buildKnowledgeIndex(TEST_ROOT);

      expect(index).toBeInstanceOf(KnowledgeHintIndex);
      expect(index.hints.length).toBeGreaterThanOrEqual(2);
      expect(index.builtAt).toBeTruthy();

      const browserHint = index.hints.find(h => h.topic === 'browser automation');
      expect(browserHint).toBeDefined();
      expect(browserHint!.confidence).toBe(0.9);
      expect(browserHint!.tags).toEqual(['browser']);
    });
  });

  describe('queryKnowledge', () => {
    let index: KnowledgeHintIndex;

    beforeEach(() => {
      const hints = [
        { topic: 'browser automation', hint: 'Use Playwright for browser tasks', source: 'hints/browser.json', confidence: 0.9, tags: ['browser'] },
        { topic: 'file handling', hint: 'Use secure-io for file operations', source: 'hints/file.json', confidence: 0.8, tags: ['file'] },
        { topic: 'screenshot capture', hint: 'Use vision actuator for screenshots', source: 'hints/vision.json', confidence: 0.7, tags: ['vision'] },
        { topic: 'api testing', hint: 'Use network actuator for API calls', source: 'hints/api.json', confidence: 0.6, tags: ['api'] },
        { topic: 'document generation', hint: 'Use media actuator for documents', source: 'hints/media.json', confidence: 0.5, tags: ['media'] },
        { topic: 'browser testing', hint: 'Run E2E tests with browser actuator', source: 'hints/e2e.json', confidence: 0.85, tags: ['browser', 'testing'] },
      ];
      index = new KnowledgeHintIndex(hints);
    });

    it('returns matching hints for a topic', () => {
      const results = queryKnowledge(index, 'browser automation');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].topic).toContain('browser');
    });

    it('returns empty array for unmatched topic', () => {
      const results = queryKnowledge(index, 'xyznonexistent');

      expect(results).toEqual([]);
    });

    it('respects maxResults limit', () => {
      const results = queryKnowledge(index, 'browser', { maxResults: 1 });

      expect(results).toHaveLength(1);
    });

    it('should complete in < 100ms', () => {
      // Create a large index for performance testing
      const manyHints = Array.from({ length: 1000 }, (_, i) => ({
        topic: `topic-${i} keyword-${i % 10}`,
        hint: `Hint for topic ${i}`,
        source: `hints/topic-${i}.json`,
        confidence: 0.5 + (i % 5) * 0.1,
        tags: [`tag-${i % 20}`],
      }));
      const largeIndex = new KnowledgeHintIndex(manyHints);

      const start = performance.now();
      queryKnowledge(largeIndex, 'keyword-5 topic');
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(100);
    });
  });
});
