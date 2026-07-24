import { afterEach, describe, expect, it, vi } from 'vitest';

import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import {
  _resetKnowledgeSlicesCacheForTests,
  isKnowledgePathExcluded,
  isKnowledgePathInSearchRoots,
  loadKnowledgeSlicesFile,
  matchesKnowledgeGlob,
  resolveKnowledgeSlice,
} from './knowledge-slices.js';

const testRoot = pathResolver.sharedTmp('knowledge-slices-test');

function fixturePath(name: string): string {
  return `${testRoot}/${name}`;
}

function writeFixture(name: string, content: unknown): string {
  if (!safeExistsSync(testRoot)) safeMkdir(testRoot, { recursive: true });
  const p = fixturePath(name);
  safeWriteFile(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return p;
}

afterEach(() => {
  _resetKnowledgeSlicesCacheForTests();
  if (safeExistsSync(testRoot)) safeRmSync(testRoot, { recursive: true, force: true });
});

describe('knowledge-slices: manifest loading (fail-open)', () => {
  it('returns null for a missing manifest file', () => {
    const missing = fixturePath('does-not-exist.json');
    expect(loadKnowledgeSlicesFile(missing)).toBeNull();
  });

  it('returns null and warns once for a JSON-parse-invalid manifest', () => {
    const p = writeFixture('broken.json', '{ not valid json');
    const warnSpy = vitestSpyConsoleWarn();
    expect(loadKnowledgeSlicesFile(p)).toBeNull();
    expect(loadKnowledgeSlicesFile(p)).toBeNull(); // cached; still fail-open
    expect(warnSpy.mock.calls.length).toBe(1); // warned exactly once despite two calls
    warnSpy.mockRestore();
  });

  it('returns null and warns once for a schema-invalid manifest', () => {
    const p = writeFixture('schema-invalid.json', {
      version: '0.1.0',
      slices: [{ match: { team_role: 'implementer' } /* no pinned/search_roots/exclude */ }],
    });
    const warnSpy = vitestSpyConsoleWarn();
    expect(loadKnowledgeSlicesFile(p)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('loads a valid manifest', () => {
    const p = writeFixture('valid.json', {
      version: '0.1.0',
      slices: [
        { match: { team_role: '*' }, exclude: ['knowledge/product/evolution/distill_*.md'] },
      ],
    });
    const file = loadKnowledgeSlicesFile(p);
    expect(file?.slices).toHaveLength(1);
  });
});

describe('knowledge-slices: resolveKnowledgeSlice — no match / fail-open', () => {
  it('resolves to an empty directive set when the manifest is missing', () => {
    const resolved = resolveKnowledgeSlice({
      teamRole: 'implementer',
      phase: 'execution',
      slicesPath: fixturePath('missing.json'),
    });
    expect(resolved).toEqual({ pinned: [], searchRoots: [], exclude: [], matchedSliceIds: [] });
  });

  it('resolves to an empty directive set when no declared slice matches', () => {
    const p = writeFixture('no-match.json', {
      version: '0.1.0',
      slices: [
        {
          id: 'reviewer-only',
          match: { team_role: 'reviewer' },
          pinned: ['knowledge/product/governance/working-philosophy.md'],
        },
      ],
    });
    const resolved = resolveKnowledgeSlice({ teamRole: 'implementer', slicesPath: p });
    expect(resolved.pinned).toEqual([]);
    expect(resolved.matchedSliceIds).toEqual([]);
  });
});

describe('knowledge-slices: precedence and merge semantics', () => {
  it('unions pinned/exclude across matching slices and lets the most-specific slice win search_roots', () => {
    const p = writeFixture('precedence.json', {
      version: '0.1.0',
      slices: [
        {
          id: 'wildcard-default',
          match: { team_role: '*', phase: '*', mission_type: '*' },
          pinned: ['knowledge/product/governance/kyberion-development-practices.md'],
          exclude: ['knowledge/product/evolution/distill_*.md'],
          search_roots: ['knowledge/product/architecture/'],
        },
        {
          id: 'implementer-execution',
          match: { team_role: 'implementer', phase: 'execution' },
          pinned: ['knowledge/product/governance/working-philosophy.md'],
          exclude: ['knowledge/public/scratch/*.md'],
          search_roots: ['knowledge/product/roles/'],
        },
      ],
    });

    const resolved = resolveKnowledgeSlice({
      teamRole: 'implementer',
      phase: 'execution',
      missionType: 'development',
      slicesPath: p,
    });

    // pinned: most-specific-first
    expect(resolved.pinned).toEqual([
      'knowledge/product/governance/working-philosophy.md',
      'knowledge/product/governance/kyberion-development-practices.md',
    ]);
    // exclude: unioned across both matching slices
    expect(resolved.exclude.sort()).toEqual(
      ['knowledge/product/evolution/distill_*.md', 'knowledge/public/scratch/*.md'].sort()
    );
    // search_roots: most-specific-wins (not merged) — the more specific slice supplies the whole list
    expect(resolved.searchRoots).toEqual(['knowledge/product/roles/']);
  });

  it('falls back to the next-most-specific slice for search_roots when the most specific declares none', () => {
    const p = writeFixture('fallback-search-roots.json', {
      version: '0.1.0',
      slices: [
        {
          id: 'wildcard-default',
          match: { team_role: '*' },
          search_roots: ['knowledge/product/architecture/'],
        },
        {
          id: 'implementer-only',
          match: { team_role: 'implementer' },
          pinned: ['knowledge/product/governance/working-philosophy.md'],
          // no search_roots declared here — more specific but nothing to contribute
        },
      ],
    });
    const resolved = resolveKnowledgeSlice({ teamRole: 'implementer', slicesPath: p });
    expect(resolved.searchRoots).toEqual(['knowledge/product/architecture/']);
  });

  it('breaks specificity ties by array order — the later-declared slice wins', () => {
    const p = writeFixture('tie-break.json', {
      version: '0.1.0',
      slices: [
        {
          id: 'first',
          match: { team_role: 'implementer' },
          search_roots: ['knowledge/product/architecture/'],
        },
        {
          id: 'second',
          match: { team_role: 'implementer' },
          search_roots: ['knowledge/product/roles/'],
        },
      ],
    });
    const resolved = resolveKnowledgeSlice({ teamRole: 'implementer', slicesPath: p });
    expect(resolved.searchRoots).toEqual(['knowledge/product/roles/']);
    expect(resolved.matchedSliceIds).toEqual(['second', 'first']);
  });

  it('dedupes pinned paths keeping the first (most specific) occurrence', () => {
    const p = writeFixture('dedup.json', {
      version: '0.1.0',
      slices: [
        {
          id: 'wildcard',
          match: { team_role: '*' },
          pinned: ['knowledge/product/governance/working-philosophy.md'],
        },
        {
          id: 'implementer',
          match: { team_role: 'implementer' },
          pinned: ['knowledge/product/governance/working-philosophy.md'],
        },
      ],
    });
    const resolved = resolveKnowledgeSlice({ teamRole: 'implementer', slicesPath: p });
    expect(resolved.pinned).toEqual(['knowledge/product/governance/working-philosophy.md']);
  });

  it('treats an omitted or unsupplied phase as the wildcard "*" request value', () => {
    const p = writeFixture('phase-wildcard.json', {
      version: '0.1.0',
      slices: [
        {
          id: 'execution-only',
          match: { phase: 'execution' },
          pinned: ['knowledge/product/governance/working-philosophy.md'],
        },
      ],
    });
    // No phase supplied => request phase is '*', which does not equal the slice's
    // declared concrete 'execution' value, so the slice must NOT match.
    const resolved = resolveKnowledgeSlice({ teamRole: 'implementer', slicesPath: p });
    expect(resolved.pinned).toEqual([]);
    // Supplying phase explicitly (the seam tests/integration use) does match.
    const resolvedWithPhase = resolveKnowledgeSlice({
      teamRole: 'implementer',
      phase: 'execution',
      slicesPath: p,
    });
    expect(resolvedWithPhase.pinned).toEqual([
      'knowledge/product/governance/working-philosophy.md',
    ]);
  });
});

describe('knowledge-slices: minimal glob matcher', () => {
  it('matches "*" within a single path segment only', () => {
    expect(
      matchesKnowledgeGlob(
        'knowledge/product/evolution/distill_foo.md',
        'knowledge/product/evolution/distill_*.md'
      )
    ).toBe(true);
    expect(
      matchesKnowledgeGlob(
        'knowledge/product/evolution/distill_foo/bar.md',
        'knowledge/product/evolution/distill_*.md'
      )
    ).toBe(false);
  });

  it('isKnowledgePathExcluded matches against any glob in the list', () => {
    const globs = ['knowledge/product/evolution/distill_*.md'];
    expect(isKnowledgePathExcluded('knowledge/product/evolution/distill_x.md', globs)).toBe(true);
    expect(isKnowledgePathExcluded('knowledge/product/architecture/foo.md', globs)).toBe(false);
    expect(isKnowledgePathExcluded('knowledge/product/architecture/foo.md', [])).toBe(false);
  });

  it('isKnowledgePathInSearchRoots matches by subtree prefix', () => {
    const roots = ['knowledge/product/roles/'];
    expect(
      isKnowledgePathInSearchRoots('knowledge/product/roles/qa_lead/PROCEDURE.md', roots)
    ).toBe(true);
    expect(isKnowledgePathInSearchRoots('knowledge/product/architecture/foo.md', roots)).toBe(
      false
    );
  });
});

function vitestSpyConsoleWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}
