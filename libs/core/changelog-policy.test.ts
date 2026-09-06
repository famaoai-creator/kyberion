import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

import { loadChangelogPolicyCatalog, resolveChangelogPolicy } from './changelog-policy.js';

describe('changelog-policy', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(pathResolver.rootResolve('libs/core/changelog-policy.ts'), {
      encoding: 'utf8',
    }) as string;
    expect(source).not.toContain('FALLBACK_CATALOG');
  });

  it('loads the canonical changelog labels', () => {
    const catalog = loadChangelogPolicyCatalog();
    expect(catalog.breaking_changes_title).toBe('⚠ BREAKING CHANGES');
    expect(catalog.uncategorized_title).toBe('Uncategorized');
    expect(catalog.type_labels.feat).toBe('Added');
  });

  it('resolves the policy object', () => {
    expect(resolveChangelogPolicy().header_template).toContain('{from}');
  });
});
