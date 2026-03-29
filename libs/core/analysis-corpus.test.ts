import { describe, expect, it } from 'vitest';
import { buildAnalysisCorpusSnippets, rankAnalysisRefs } from './analysis-corpus.js';

describe('analysis-corpus', () => {
  it('builds snippets from governed knowledge refs', () => {
    const snippets = buildAnalysisCorpusSnippets([
      'knowledge/public/incidents/post-mortem-20260228.md',
    ]);
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets[0]?.ref).toContain('knowledge/public/incidents/post-mortem-20260228.md');
    expect(snippets[0]?.title.length).toBeGreaterThan(0);
    expect(snippets[0]?.excerpt.length).toBeGreaterThan(0);
  });

  it('ignores unsupported refs', () => {
    const snippets = buildAnalysisCorpusSnippets([
      'vault/private/secret.md',
      'knowledge/public/incidents/post-mortem-20260228.md',
    ]);
    expect(snippets.every((item) => !item.ref.startsWith('vault/'))).toBe(true);
  });

  it('ranks refs toward active target and scope before broad knowledge', () => {
    const ranked = rankAnalysisRefs({
      refs: [
        'knowledge/public/architecture/general-guidance.md',
        'knowledge/public/incidents/post-mortem-20260228.md',
        'active/projects/PRJ-TEST/tracks/TRK-9/review-target-notes.md',
      ],
      projectId: 'PRJ-TEST',
      trackId: 'TRK-9',
      reviewTarget: 'track:TRK-9',
      utterance: 'TRK-9 review target',
    });
    expect(ranked[0]).toBe('active/projects/PRJ-TEST/tracks/TRK-9/review-target-notes.md');
    expect(ranked[1]).toBe('knowledge/public/incidents/post-mortem-20260228.md');
  });
});
