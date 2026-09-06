import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveDocumentationTargets } from './check_documentation_links.js';

describe('check_documentation_links', () => {
  it('uses explicit root references without restoring a generic root fallback', () => {
    const source = pathResolver.rootResolve('docs/GLOSSARY.md');
    const explicit = resolveDocumentationTargets(source, 'knowledge/product/schemas/example.json');
    expect(explicit).toContain(pathResolver.rootResolve('knowledge/product/schemas/example.json'));

    const relative = resolveDocumentationTargets(source, 'missing/example.json');
    expect(relative).not.toContain(pathResolver.rootResolve('missing/example.json'));
  });
});
