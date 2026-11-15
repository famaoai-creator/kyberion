import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import {
  checkDocumentationLinks,
  resolveDocumentationTargets,
} from './check_documentation_links.js';
import { safeWriteFile, safeRmSync } from '@agent/core/secure-io';

describe('check_documentation_links', () => {
  it('excludes vendored documentation before reading its unavailable links', () => {
    expect(
      checkDocumentationLinks([
        pathResolver.rootResolve('knowledge/public/external-wisdom/nonexistent-fixture.md'),
      ])
    ).toEqual([]);
  });

  it('accepts references to private knowledge unavailable in a checkout', () => {
    const source = pathResolver.sharedTmp('documentation-private-link-fixture.md');
    safeWriteFile(
      source,
      '[private](knowledge/personal/nonexistent-fixture.md)\n[tenant](knowledge/confidential/nonexistent-fixture.md)\n[missing](missing.md)'
    );
    try {
      const failures = checkDocumentationLinks([source]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('missing.md');
    } finally {
      safeRmSync(source, { force: true });
    }
  });
  it('uses explicit root references without restoring a generic root fallback', () => {
    const source = pathResolver.rootResolve('docs/GLOSSARY.md');
    const explicit = resolveDocumentationTargets(source, 'knowledge/product/schemas/example.json');
    expect(explicit).toContain(pathResolver.rootResolve('knowledge/product/schemas/example.json'));

    const relative = resolveDocumentationTargets(source, 'missing/example.json');
    expect(relative).not.toContain(pathResolver.rootResolve('missing/example.json'));
  });
});
