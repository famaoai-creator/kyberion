import { describe, expect, it } from 'vitest';
import { loadRetentionCatalog, pathResolver, type LoadedRetentionCatalog } from '@agent/core';
import {
  checkRuntimeStoreReferences,
  collectRuntimeStoreReferences,
  findRuntimeStoreReferences,
  findStaleExemptions,
  readRuntimeStoreSourceFile,
  RUNTIME_STORE_EXEMPTIONS,
} from './check_runtime_store_retention.js';

function catalogOf(paths: string[]): LoadedRetentionCatalog {
  return {
    source: 'catalog',
    warnings: [],
    entries: paths.map((path) => ({
      path,
      artifact_class: 'state',
      action: 'review_required',
    })),
  };
}

describe('runtime store retention gate (G14)', () => {
  it('extracts literal store names from both path forms, with the line of the name', () => {
    const source = [
      "const A = 'active/shared/runtime/alpha-ledger.jsonl';",
      "const B = pathResolver.shared('runtime/beta/state.json');",
      'const C = pathResolver.shared(',
      "  'runtime/gamma.json'",
      ');',
      '// see active/shared/runtime/delta.json.',
    ].join('\n');
    expect(findRuntimeStoreReferences(source, 'libs/x.ts')).toEqual([
      { name: 'alpha-ledger.jsonl', file: 'libs/x.ts', line: 1 },
      { name: 'beta', file: 'libs/x.ts', line: 2 },
      { name: 'gamma.json', file: 'libs/x.ts', line: 4 },
      { name: 'delta.json', file: 'libs/x.ts', line: 6 },
    ]);
  });

  it('skips dynamic names and the bare runtime root', () => {
    const source = [
      'const a = `active/shared/runtime/${name}/x.json`;',
      'const b = `active/shared/runtime/dot-${id}.jsonl`;',
      "const c = 'active/shared/runtime/{{store}}';",
      '// everything under active/shared/runtime/.',
      "const d = pathResolver.shared('runtime');",
    ].join('\n');
    expect(findRuntimeStoreReferences(source, 'libs/y.ts')).toEqual([]);
  });

  it('fails an undeclared store with file:line and the catalog fix, passes a declared one', () => {
    const refs = [
      { name: 'declared', file: 'libs/a.ts', line: 3 },
      { name: 'new-ledger.jsonl', file: 'libs/b.ts', line: 7 },
    ];
    const violations = checkRuntimeStoreReferences(
      refs,
      catalogOf(['active/shared/runtime/declared/sub']),
      []
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('libs/b.ts:7');
    expect(violations[0]).toContain("'active/shared/runtime/new-ledger.jsonl'");
    expect(violations[0]).toContain(
      'add an entry to knowledge/product/governance/storage-retention-catalog.json'
    );
  });

  it('honours file-scoped exemptions only in their files, and reports stale ones', () => {
    const exemptions = [{ name: 'fixture', files: ['scripts/a.ts'], reason: 'fixture string' }];
    const inScope = [{ name: 'fixture', file: 'scripts/a.ts', line: 1 }];
    const outOfScope = [{ name: 'fixture', file: 'libs/b.ts', line: 1 }];
    expect(checkRuntimeStoreReferences(inScope, catalogOf([]), exemptions)).toEqual([]);
    expect(checkRuntimeStoreReferences(outOfScope, catalogOf([]), exemptions)).toHaveLength(1);
    expect(findStaleExemptions(inScope, exemptions)).toEqual([]);
    expect(findStaleExemptions([], exemptions)[0]).toContain("exemption 'fixture'");
  });

  it('fails closed when the catalog fell back to built-in defaults', () => {
    const violations = checkRuntimeStoreReferences(
      [],
      { source: 'builtin-defaults', warnings: ['corrupt'], entries: [] },
      []
    );
    expect(violations[0]).toContain('did not load (corrupt)');
  });

  it('every exemption carries a reason', () => {
    for (const exemption of RUNTIME_STORE_EXEMPTIONS) expect(exemption.reason.trim()).not.toBe('');
  });

  it('rejects a non-regular source path', () => {
    expect(() => readRuntimeStoreSourceFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

  it('the repository itself passes: every literal runtime store is cataloged', () => {
    const refs = collectRuntimeStoreReferences();
    expect(refs.length).toBeGreaterThan(0);
    expect(checkRuntimeStoreReferences(refs, loadRetentionCatalog())).toEqual([]);
    expect(findStaleExemptions(refs)).toEqual([]);
  }, 60_000);
});
