/**
 * TK-11 deterministic facet-content evaluation.
 * Provider-backed evaluation remains optional; this hermetic layer checks the
 * authored facet contract independently from engine execution.
 */

import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  resolveFacets,
  validateFacetPurity,
  type FacetKind,
  type FacetRequest,
  type ResolvedFacet,
  type ResolvedFacets,
} from '@agent/core/facet-registry';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';
import { readSafeJsonFile } from './lib/json-input.js';

export interface FacetEvalFixture {
  kind: FacetKind;
  name: string;
  must_include: string[];
  must_not_include?: string[];
}

export interface FacetEvalResult {
  fixture: string;
  passed: boolean;
  findings: string[];
}

function requestFor(fixture: FacetEvalFixture): FacetRequest {
  if (fixture.kind === 'persona') return { persona: fixture.name };
  if (fixture.kind === 'policy') return { policies: [fixture.name] };
  if (fixture.kind === 'instruction') return { instructions: [fixture.name] };
  return { output_contract: fixture.name };
}

function resolvedFacetFor(
  facets: ResolvedFacets,
  fixture: FacetEvalFixture
): ResolvedFacet | undefined {
  if (fixture.kind === 'persona') {
    return facets.persona?.name === fixture.name ? facets.persona : undefined;
  }
  if (fixture.kind === 'policy')
    return facets.policies.find((facet) => facet.name === fixture.name);
  if (fixture.kind === 'instruction') {
    return facets.instructions.find((facet) => facet.name === fixture.name);
  }
  return facets.output_contract?.name === fixture.name ? facets.output_contract : undefined;
}

function evaluateFixture(
  entry: string,
  fixture: FacetEvalFixture,
  resolve: () => ResolvedFacet | undefined
): FacetEvalResult {
  const findings: string[] = [];
  try {
    const facet = resolve();
    if (!facet) findings.push('facet did not resolve');
    else {
      const content = facet.content.toLowerCase();
      for (const term of fixture.must_include) {
        if (!content.includes(term.toLowerCase())) findings.push(`missing: ${term}`);
      }
      for (const term of fixture.must_not_include || []) {
        if (content.includes(term.toLowerCase())) findings.push(`forbidden: ${term}`);
      }
      findings.push(...validateFacetPurity(facet));
    }
  } catch (error) {
    findings.push(error instanceof Error ? error.message : String(error));
  }
  return { fixture: entry, passed: findings.length === 0, findings };
}

function fixtureEntries(root: string): Array<{ entry: string; fixture: FacetEvalFixture }> {
  let safeRoot: string;
  try {
    safeRoot = assertSafeRepositoryPath(root, { allowMissingLeaf: true });
    if (!safeExistsSync(safeRoot) || !safeLstat(safeRoot).isDirectory()) return [];
  } catch {
    return [];
  }

  return safeReaddir(safeRoot)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .flatMap((entry) => {
      try {
        const fixturePath = assertSafeRepositoryPath(path.join(safeRoot, entry));
        if (!safeLstat(fixturePath).isFile()) return [];
        return [
          {
            entry,
            fixture: readSafeJsonFile<FacetEvalFixture>(
              fixturePath,
              `facet evaluation fixture ${entry}`
            ),
          },
        ];
      } catch {
        return [];
      }
    });
}

export function evaluateFacetFixtures(
  root = pathResolver.rootResolve('eval/facets')
): FacetEvalResult[] {
  return fixtureEntries(root).map(({ entry, fixture }) =>
    evaluateFixture(entry, fixture, () => {
      const resolved = resolveFacets(requestFor(fixture), { tier: 'public' });
      return resolvedFacetFor(resolved, fixture);
    })
  );
}

/**
 * Apply the same TK-11 fixtures to facets already resolved by an eval session.
 * This keeps tenant overlays and reloads on the exact runtime resolution path
 * instead of evaluating a second public-only resolution.
 */
export function evaluateResolvedFacetFixtures(
  facets: ResolvedFacets,
  root = pathResolver.rootResolve('eval/facets')
): FacetEvalResult[] {
  return fixtureEntries(root)
    .filter(({ fixture }) => Boolean(resolvedFacetFor(facets, fixture)))
    .map(({ entry, fixture }) =>
      evaluateFixture(entry, fixture, () => resolvedFacetFor(facets, fixture))
    );
}

export function main(argv: string[] = []): number {
  const results = evaluateFacetFixtures();
  const report = {
    schema_version: 'facet-eval.v1',
    mode: 'deterministic-content-contract',
    passed: results.every((result) => result.passed),
    results,
  };
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    for (const result of results) {
      process.stdout.write(
        `${result.passed ? 'PASS' : 'FAIL'} ${result.fixture}${result.findings.length ? ` — ${result.findings.join('; ')}` : ''}\n`
      );
    }
  }
  return report.passed ? 0 : 1;
}

if (
  isDirectScript(import.meta.url, 'eval_facets.ts') ||
  isDirectScript(import.meta.url, 'eval_facets.js')
)
  void defineScript({
    name: 'eval:facets',
    flags: [],
    run(context) {
      const status = main(context.argv);
      if (status !== 0) throw new Error(`facet evaluation failed with exit code ${status}`);
    },
  })();
