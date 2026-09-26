import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { loadOutcomeCatalog } from './work-design.js';
import { loadIntentRoutingMap } from './router-contract.js';
import { classifyError } from './error-classifier.js';

/**
 * PE-02 regression: Chronos runs with its package directory as cwd
 * (`pnpm --dir presence/displays/chronos-mirror-v2 start`). Catalog schemas
 * given as repo-relative strings were resolved against cwd, so every
 * approval request created from Chronos (createApprovalRequest ->
 * work-design outcome catalog) failed. Schemas must resolve against the
 * Kyberion root, whatever the cwd.
 */
describe('governed catalog schemas resolve against the Kyberion root', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the outcome, intent-routing and error-classifier catalogs from a sub-directory cwd', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(
      path.join(pathResolver.rootDir(), 'presence', 'displays', 'chronos-mirror-v2')
    );
    expect(Object.keys(loadOutcomeCatalog()).length).toBeGreaterThan(0);
    expect(loadIntentRoutingMap()).toBeTypeOf('object');
    expect(classifyError(new Error('ENOENT: no such file or directory')).category).toBeTypeOf(
      'string'
    );
  });
});
