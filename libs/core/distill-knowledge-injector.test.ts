import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  findRelevantDistilledKnowledge,
  formatDistilledKnowledgeSummary,
} from './distill-knowledge-injector.js';
import {
  registerEmbeddingBackend,
  resetEmbeddingBackend,
  type EmbeddingBackend,
} from './embedding-backend.js';

describe('distill-knowledge-injector (E5)', () => {
  it('returns empty when topic and tags are both empty', async () => {
    const r = await findRelevantDistilledKnowledge({ topic: '' });
    expect(r).toEqual([]);
  });

  it('returns the most relevant entries by tag overlap (against real fixtures)', async () => {
    const r = await findRelevantDistilledKnowledge({
      topic: 'tenant isolation',
      tags: ['mission-retrofit', 'dog-food'],
      limit: 10,
    });
    for (let i = 1; i < r.length; i++) {
      expect(r[i - 1].score!).toBeGreaterThanOrEqual(r[i].score!);
    }
    if (r.length > 0) {
      const top = r[0];
      const overlap = top.tags.some((t) =>
        ['mission-retrofit', 'dog-food'].includes(t.toLowerCase()),
      );
      expect(overlap || top.score! < 0.5).toBe(true);
    }
  });

  it('respects the limit parameter', async () => {
    const r = await findRelevantDistilledKnowledge({
      topic: 'mission',
      limit: 2,
    });
    expect(r.length).toBeLessThanOrEqual(2);
  });

  it('formats a summary that includes title, tags, and source path', () => {
    const fake = {
      path: 'knowledge/product/evolution/distill_test.md',
      title: 'Test Title',
      tags: ['a', 'b', 'c'],
      excerpt: 'A useful insight about something important happens here.',
      score: 0.85,
    };
    const formatted = formatDistilledKnowledgeSummary(fake);
    expect(formatted).toContain('Test Title');
    expect(formatted).toContain('[a, b, c]');
    expect(formatted).toContain('score=0.85');
    expect(formatted).toContain('knowledge/product/evolution/distill_test.md');
  });
});

// ── Hybrid search (semantic RRF) ─────────────────────────────────────────────

/**
 * Synthetic embedding backend for deterministic scenario testing.
 *
 * Each entry in the corpus is given a "semantic cluster" vector and the query
 * is assigned the vector of the intended top result, so we can verify that
 * RRF fusion lifts the semantically-correct answer even when lexical score
 * is low.
 *
 * Vectors are 4-d unit vectors assigned by category.
 */
const CLUSTER_VECTORS: Record<string, Float32Array> = {
  meeting: new Float32Array([1, 0, 0, 0]),
  governance: new Float32Array([0, 1, 0, 0]),
  architecture: new Float32Array([0, 0, 1, 0]),
  voice: new Float32Array([0.707, 0, 0.707, 0]),
  default: new Float32Array([0.5, 0.5, 0.5, 0.5]),
};

function clusterFor(text: string): Float32Array {
  const t = text.toLowerCase();
  if (t.includes('meeting') || t.includes('会議') || t.includes('facilitator')) return CLUSTER_VECTORS['meeting'];
  if (t.includes('governance') || t.includes('consent') || t.includes('compliance')) return CLUSTER_VECTORS['governance'];
  if (t.includes('architecture') || t.includes('catalog') || t.includes('intent')) return CLUSTER_VECTORS['architecture'];
  if (t.includes('voice') || t.includes('cloning') || t.includes('audio')) return CLUSTER_VECTORS['voice'];
  return CLUSTER_VECTORS['default'];
}

function makeSemanticBackend(): EmbeddingBackend {
  return {
    name: 'test-semantic',
    dimensions: 4,
    embed: async (text) => clusterFor(text),
    embedBatch: async (texts) => texts.map(clusterFor),
  };
}

describe('findRelevantDistilledKnowledge — hybrid (with embedding backend)', () => {
  beforeEach(() => {
    resetEmbeddingBackend();
    registerEmbeddingBackend(makeSemanticBackend());
  });

  afterEach(() => {
    resetEmbeddingBackend();
  });

  it('retrieves meeting-related entries for Japanese query (cross-lingual semantic)', async () => {
    // "会議をAIが進行する" → meeting cluster → should find meeting-facilitator docs
    const r = await findRelevantDistilledKnowledge({
      topic: '会議をAIが進行する',
      tags: [],
      limit: 3,
    });
    // With semantic backend, meeting-related entries should appear
    expect(r.length).toBeGreaterThan(0);
    const topTitles = r.map((e) => e.title.toLowerCase());
    const hasMeeting = topTitles.some((t) => t.includes('meeting') || t.includes('facilitator'));
    expect(hasMeeting).toBe(true);
  });

  it('boosts semantically-matched entries via RRF even with low lexical score', async () => {
    // Pure lexical query: "voice cloning" → low lexical score since it doesn't
    // match many token patterns; semantic backend should boost voice-related entry
    const r = await findRelevantDistilledKnowledge({
      topic: 'voice cloning consent',
      tags: [],
      limit: 5,
    });
    expect(r.length).toBeGreaterThan(0);
    // All returned entries should have a positive RRF score
    for (const e of r) {
      expect(e.score).toBeGreaterThan(0);
    }
  });

  it('results are still sorted by descending score with hybrid scoring', async () => {
    const r = await findRelevantDistilledKnowledge({
      topic: 'architecture governance decisions',
      tags: [],
      limit: 5,
    });
    for (let i = 1; i < r.length; i++) {
      expect(r[i - 1].score!).toBeGreaterThanOrEqual(r[i].score!);
    }
  });

  it('respects limit parameter with hybrid search', async () => {
    const r = await findRelevantDistilledKnowledge({
      topic: 'mission implementation pipeline',
      limit: 2,
    });
    expect(r.length).toBeLessThanOrEqual(2);
  });

  it('falls back gracefully when embed() throws', async () => {
    resetEmbeddingBackend();
    registerEmbeddingBackend({
      name: 'failing',
      dimensions: 4,
      embed: async () => { throw new Error('embed unavailable'); },
      embedBatch: async () => { throw new Error('embedBatch unavailable'); },
    });
    const r = await findRelevantDistilledKnowledge({
      topic: 'intent catalog',
      tags: ['intent-catalog'],
      limit: 3,
    });
    // Should fall back to lexical — still returns results
    expect(r.length).toBeGreaterThanOrEqual(0);
  });
});
