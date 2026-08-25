/**
 * TK-11 deterministic facet-content evaluation.
 * Provider-backed evaluation remains optional; this hermetic layer checks the
 * authored facet contract independently from engine execution.
 */

import * as path from 'node:path';
import {
  pathResolver,
  resolveFacets,
  safeReadFile,
  safeReaddir,
  validateFacetPurity,
} from '@agent/core';
import type { FacetKind, FacetRequest } from '@agent/core';
import { defineScript, isDirectScript } from './lib/harness.js';

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

export function evaluateFacetFixtures(
  root = pathResolver.rootResolve('eval/facets')
): FacetEvalResult[] {
  return safeReaddir(root)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => {
      const fixturePath = path.join(root, entry);
      const fixture = JSON.parse(
        String(safeReadFile(fixturePath, { encoding: 'utf8' }))
      ) as FacetEvalFixture;
      const findings: string[] = [];
      try {
        const request = requestFor(fixture);
        const resolved = resolveFacets(request, { tier: 'public' });
        const facet =
          fixture.kind === 'persona'
            ? resolved.persona
            : fixture.kind === 'policy'
              ? resolved.policies[0]
              : fixture.kind === 'instruction'
                ? resolved.instructions[0]
                : resolved.output_contract;
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
    });
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
