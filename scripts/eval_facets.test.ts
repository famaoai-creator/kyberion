import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { evaluateFacetFixtures } from './eval_facets.js';

const fixtureRoot = pathResolver.sharedTmp(`eval-facets-loader-${process.pid}`);

afterEach(() => {
  safeRmSync(fixtureRoot, { recursive: true, force: true });
});

describe('eval facet fixture loader', () => {
  it('does not read a symlinked fixture', () => {
    const target = path.join(fixtureRoot, 'target.json');
    const linked = path.join(fixtureRoot, 'linked.json');
    safeMkdir(fixtureRoot, { recursive: true });
    safeWriteFile(
      target,
      JSON.stringify({
        kind: 'persona',
        name: 'missing-fixture',
        must_include: [],
      })
    );
    safeSymlinkSync(target, linked);

    expect(evaluateFacetFixtures(fixtureRoot)).toEqual([
      expect.objectContaining({ fixture: 'target.json' }),
    ]);
  });
});
