import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Mock dependencies
vi.mock('../path-resolver.js', () => ({
  knowledge: (sub = '') => (sub ? `/tmp/test-knowledge-base/${sub}` : '/tmp/test-knowledge-base'),
  // Named pathResolver object used by core.ts / embedding-backend.ts
  pathResolver: {
    shared: (sub = '') => (sub ? `/tmp/test-shared/${sub}` : '/tmp/test-shared'),
    rootDir: () => '/tmp/test-root',
    knowledge: (sub = '') => (sub ? `/tmp/test-knowledge-base/${sub}` : '/tmp/test-knowledge-base'),
  },
}));

vi.mock('../secure-io.js', () => ({
  safeExistsSync: (p: string) => fs.existsSync(p),
  safeReaddir: (p: string) => fs.readdirSync(p),
  safeReadFile: (p: string, opts: any) => fs.readFileSync(p, opts.encoding),
  safeWriteFile: () => {
    /* no-op in tests */
  },
  safeMkdir: () => {
    /* no-op in tests */
  },
  safeStat: (p: string) => fs.statSync(p),
  safeUnlinkSync: () => {
    /* no-op in tests */
  },
}));

import {
  buildKnowledgeIndex,
  queryKnowledge,
  queryKnowledgeHybrid,
  KnowledgeHintIndex,
  _chunkMarkdownBody,
  type KnowledgeHint,
} from './knowledge-index.js';
import { registerEmbeddingBackend } from '../embedding-backend.js';

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
        {
          topic: 'browser automation',
          hint: 'Use Playwright for web scraping',
          confidence: 0.9,
          tags: ['browser'],
        },
        { topic: 'file operations', hint: 'Always use secure-io', confidence: 0.8 },
      ];
      fs.writeFileSync(path.join(HINTS_DIR, 'test-hints.json'), JSON.stringify(hints));

      const index = await buildKnowledgeIndex(TEST_ROOT);

      expect(index).toBeInstanceOf(KnowledgeHintIndex);
      expect(index.hints.length).toBeGreaterThanOrEqual(2);
      expect(index.builtAt).toBeTruthy();

      const browserHint = index.hints.find((h) => h.topic === 'browser automation');
      expect(browserHint).toBeDefined();
      expect(browserHint!.confidence).toBe(0.9);
      expect(browserHint!.tags).toEqual(['browser']);
    });

    it('promotes markdown frontmatter and taxonomy defaults into ranking metadata', async () => {
      const proceduresDir = path.join(TEST_ROOT, 'public/procedures');
      ensureDir(proceduresDir);
      fs.writeFileSync(
        path.join(proceduresDir, 'ranking.md'),
        [
          '---',
          'title: Ranking standard',
          'last_updated: 2026-07-12',
          '---',
          '',
          'Use the shared ranking signals for runtime retrieval.',
        ].join('\n')
      );

      const index = await buildKnowledgeIndex(TEST_ROOT);
      const rankingHint = index.hints.find((hint) => hint.source.endsWith('procedures/ranking.md'));
      expect(rankingHint).toMatchObject({
        last_updated: '2026-07-12',
        doc_authority: 'recipe',
        scope: 'global',
      });
    });
  });

  describe('queryKnowledge', () => {
    let index: KnowledgeHintIndex;

    beforeEach(() => {
      const hints = [
        {
          topic: 'browser automation',
          hint: 'Use Playwright for browser tasks',
          source: 'hints/browser.json',
          confidence: 0.9,
          tags: ['browser'],
        },
        {
          topic: 'file handling',
          hint: 'Use secure-io for file operations',
          source: 'hints/file.json',
          confidence: 0.8,
          tags: ['file'],
        },
        {
          topic: 'screenshot capture',
          hint: 'Use vision actuator for screenshots',
          source: 'hints/vision.json',
          confidence: 0.7,
          tags: ['vision'],
        },
        {
          topic: 'api testing',
          hint: 'Use network actuator for API calls',
          source: 'hints/api.json',
          confidence: 0.6,
          tags: ['api'],
        },
        {
          topic: 'document generation',
          hint: 'Use media actuator for documents',
          source: 'hints/media.json',
          confidence: 0.5,
          tags: ['media'],
        },
        {
          topic: 'browser testing',
          hint: 'Run E2E tests with browser actuator',
          source: 'hints/e2e.json',
          confidence: 0.85,
          tags: ['browser', 'testing'],
        },
      ];
      index = new KnowledgeHintIndex(hints);
    });

    it('returns matching hints for a topic', () => {
      const results = queryKnowledge(index, 'browser automation');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].topic).toContain('browser');
    });

    it('uses shared metadata signals to break lexical ties', () => {
      const tied = new KnowledgeHintIndex([
        {
          topic: 'governance search',
          hint: 'shared query term',
          source: 'governance.md',
          confidence: 0.8,
          doc_authority: 'policy',
          scope: 'global',
          last_updated: '2026-07-12',
        },
        {
          topic: 'governance search',
          hint: 'shared query term',
          source: 'advisory.md',
          confidence: 0.8,
          doc_authority: 'advisory',
          scope: 'global',
          last_updated: '2026-07-12',
        },
      ]);
      const results = queryKnowledge(tied, 'shared query', { scope: 'global' });
      expect(results[0].source).toBe('governance.md');
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

  describe('body chunk indexing (KM-02)', () => {
    it('short bodies produce no chunks; long bodies chunk near the target size', () => {
      expect(_chunkMarkdownBody('# T\n\nshort body')).toEqual([]);

      const section = (n: number) =>
        `## Section ${n}\n\n${'lorem ipsum dolor sit amet '.repeat(30)}`;
      const content = `# Title\n\n${[1, 2, 3, 4].map(section).join('\n\n')}`;
      const chunks = _chunkMarkdownBody(content);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(1600);
      }
      // Heading text survives into chunks so section-only terms are searchable.
      expect(chunks.join(' ')).toContain('Section 4');
    });

    it('caps runaway documents at the per-doc chunk limit', () => {
      const huge = `# T\n\n${'word '.repeat(20000)}`;
      expect(_chunkMarkdownBody(huge).length).toBeLessThanOrEqual(12);
    });

    it('queryKnowledge aggregates chunk hits back to the parent document', () => {
      const hints: KnowledgeHint[] = [
        {
          topic: 'Deploy guide',
          hint: 'Deploy guide. Introduction paragraph.',
          source: 'public/deploy.md',
          confidence: 0.6,
        },
        {
          topic: 'Deploy guide',
          hint: 'The zebra rollback lever lives in section nine.',
          source: 'public/deploy.md#chunk3',
          parentSource: 'public/deploy.md',
          chunkIndex: 3,
          confidence: 0.55,
        },
      ];
      const index = new KnowledgeHintIndex(hints);
      const results = queryKnowledge(index, 'zebra rollback lever');

      expect(results).toHaveLength(1);
      expect(results[0].source).toBe('public/deploy.md');
      expect(results[0].matchedChunkIndex).toBe(3);
      expect(results[0].hint).toContain('zebra rollback lever');
    });

    it('hybrid results carry the embedding backend name and stay document-unique', async () => {
      registerEmbeddingBackend({
        name: 'unit-test-embedding',
        async embed() {
          return new Float32Array([1, 0]);
        },
        async embedBatch(texts: string[]) {
          return texts.map(() => new Float32Array([1, 0]));
        },
      });
      try {
        const hints: KnowledgeHint[] = [
          {
            topic: 'Deploy guide',
            hint: 'Deploy guide. zebra intro.',
            source: 'public/deploy.md',
            confidence: 0.6,
          },
          {
            topic: 'Deploy guide',
            hint: 'zebra rollback lever details.',
            source: 'public/deploy.md#chunk1',
            parentSource: 'public/deploy.md',
            chunkIndex: 1,
            confidence: 0.55,
          },
        ];
        const index = new KnowledgeHintIndex(hints);
        const results = await queryKnowledgeHybrid(index, 'zebra rollback');

        expect(results).toHaveLength(1);
        expect(results[0].source).toBe('public/deploy.md');
        expect(results[0].embeddingBackend).toBe('unit-test-embedding');
      } finally {
        registerEmbeddingBackend(null as never);
      }
    });

    it('applies shared metadata ranking as a third hybrid signal', async () => {
      registerEmbeddingBackend({
        name: 'unit-test-embedding',
        async embed() {
          return new Float32Array([1, 0]);
        },
        async embedBatch(texts: string[]) {
          return texts.map(() => new Float32Array([1, 0]));
        },
      });
      try {
        const index = new KnowledgeHintIndex([
          {
            topic: 'governance search',
            hint: 'shared query term',
            source: 'advisory.md',
            confidence: 0.8,
            doc_authority: 'advisory',
            scope: 'global',
            last_updated: '2026-07-12',
          },
          {
            topic: 'governance search',
            hint: 'shared query term',
            source: 'governance.md',
            confidence: 0.8,
            doc_authority: 'policy',
            scope: 'global',
            last_updated: '2026-07-12',
          },
        ]);
        const results = await queryKnowledgeHybrid(index, 'shared query', { scope: 'global' });
        expect(results[0].source).toBe('governance.md');
      } finally {
        registerEmbeddingBackend(null as never);
      }
    });
  });
});
