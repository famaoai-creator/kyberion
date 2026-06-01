import { describe, expect, it } from 'vitest';

import { loadChangelogPolicyCatalog, resolveChangelogPolicy } from './changelog-policy.js';

describe('changelog-policy', () => {
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
