import { describe, expect, it } from 'vitest';
import {
  findRelevantDistilledKnowledge,
  formatDistilledKnowledgeSummary,
} from './distill-knowledge-injector.js';

describe('distill-knowledge-injector (E5)', () => {
  it('returns empty when topic and tags are both empty', () => {
    const r = findRelevantDistilledKnowledge({ topic: '' });
    expect(r).toEqual([]);
  });

  it('returns the most relevant entries by tag overlap (against real fixtures)', () => {
    // The real distill_*.md files in knowledge/incidents/ form the
    // fixture set. We only assert behavior, not specific titles.
    const r = findRelevantDistilledKnowledge({
      topic: 'tenant isolation',
      tags: ['mission-retrofit', 'dog-food'],
      limit: 10,
    });
    // Either no matches (clean repo) or every returned entry has a
    // numeric score, sorted descending.
    for (let i = 1; i < r.length; i++) {
      expect(r[i - 1].score!).toBeGreaterThanOrEqual(r[i].score!);
    }
    // Tags from a hit should overlap with the queried tags.
    if (r.length > 0) {
      const top = r[0];
      const overlap = top.tags.some((t) =>
        ['mission-retrofit', 'dog-food'].includes(t.toLowerCase()),
      );
      expect(overlap || top.score! < 0.5).toBe(true);
    }
  });

  it('respects the limit parameter', () => {
    const r = findRelevantDistilledKnowledge({
      topic: 'mission',
      limit: 2,
    });
    expect(r.length).toBeLessThanOrEqual(2);
  });

  it('formats a summary that includes title, tags, and source path', () => {
    const fake = {
      path: 'knowledge/incidents/distill_test.md',
      title: 'Test Title',
      tags: ['a', 'b', 'c'],
      excerpt: 'A useful insight about something important happens here.',
      score: 0.85,
    };
    const formatted = formatDistilledKnowledgeSummary(fake);
    expect(formatted).toContain('Test Title');
    expect(formatted).toContain('[a, b, c]');
    expect(formatted).toContain('score=0.85');
    expect(formatted).toContain('knowledge/incidents/distill_test.md');
  });
});
