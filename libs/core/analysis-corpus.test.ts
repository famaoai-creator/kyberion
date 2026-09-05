import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildAnalysisCorpusSnippets, rankAnalysisRefs } from './analysis-corpus.js';
import { pathResolver } from './path-resolver.js';

describe('analysis-corpus', () => {
  it('builds snippets from governed knowledge refs', () => {
    const snippets = buildAnalysisCorpusSnippets([
      'knowledge/product/incidents/post-mortem-20260228.md',
    ]);
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets[0]?.ref).toContain('knowledge/product/incidents/post-mortem-20260228.md');
    expect(snippets[0]?.title.length).toBeGreaterThan(0);
    expect(snippets[0]?.excerpt.length).toBeGreaterThan(0);
  });

  it('ignores unsupported refs', () => {
    const snippets = buildAnalysisCorpusSnippets([
      'vault/private/secret.md',
      'knowledge/product/incidents/post-mortem-20260228.md',
    ]);
    expect(snippets.every((item) => !item.ref.startsWith('vault/'))).toBe(true);
  });

  it('rejects an allowed lexical ref that traverses a symlink', () => {
    const target = pathResolver.sharedTmp(`analysis-corpus-target-${process.pid}.md`);
    const link = pathResolver.rootResolve(`active/projects/analysis-corpus-link-${process.pid}.md`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(target, '# External\n\nThis content must not become model-visible.\n');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link);
    try {
      expect(
        buildAnalysisCorpusSnippets([
          pathResolver.toRepoRelative(link),
          'knowledge/product/incidents/post-mortem-20260228.md',
        ])
      ).toHaveLength(1);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(target, { force: true });
    }
  });

  it('ignores an allowed lexical ref that resolves to a directory', () => {
    const directory = pathResolver.rootResolve(
      `active/projects/analysis-corpus-directory-${process.pid}`
    );
    fs.mkdirSync(directory, { recursive: true });
    try {
      expect(
        buildAnalysisCorpusSnippets([
          pathResolver.toRepoRelative(directory),
          'knowledge/product/incidents/post-mortem-20260228.md',
        ])
      ).toHaveLength(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ranks refs toward active target and scope before broad knowledge', () => {
    const ranked = rankAnalysisRefs({
      refs: [
        'knowledge/product/architecture/general-guidance.md',
        'knowledge/product/incidents/post-mortem-20260228.md',
        'active/projects/PRJ-TEST/tracks/TRK-9/review-target-notes.md',
      ],
      projectId: 'PRJ-TEST',
      trackId: 'TRK-9',
      reviewTarget: 'track:TRK-9',
      utterance: 'TRK-9 review target',
    });
    expect(ranked[0]).toBe('active/projects/PRJ-TEST/tracks/TRK-9/review-target-notes.md');
    expect(ranked[1]).toBe('knowledge/product/incidents/post-mortem-20260228.md');
  });
});
