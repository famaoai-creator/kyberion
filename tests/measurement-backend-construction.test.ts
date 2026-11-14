import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

/**
 * Measurement backend construction gate.
 *
 * A measurement (live backend scenarios, backend conformance, model
 * role-fitness probes) must observe the PROVIDER. The route's request wrapper
 * (`bindReasoningRequestTimeout`) answers an abort for the provider and the
 * installed default chain cuts every turn at the route's 60s limit, so a
 * measurement built on either records the wrapper, not the provider (found
 * reviewing PR #1412). Measurement entry points therefore construct their
 * backend with `requestTimeout: 'caller'` and bound each call themselves, and
 * never borrow the installed chain via `getReasoningBackend()`.
 *
 * Every non-test source that defines or calls a measurement function must be
 * registered below with how it obtains its backend:
 * - `caller-bounded`: builds its own backend; every
 *   `buildTaskReasoningBackend(` / `constructTaskReasoningBackend(` call passes
 *   `requestTimeout: 'caller'`;
 * - `receives`: is handed a backend (or calls an entry point that builds
 *   one) and constructs none itself.
 * No entry point may call `getReasoningBackend(`.
 * Rule: knowledge/product/governance/operations-hygiene-runbook.md §7
 * ("Measure the provider, not the request wrapper").
 */
type Construction = 'caller-bounded' | 'receives';

const MEASUREMENT_ENTRY_POINTS: Record<string, { construction: Construction; reason: string }> = {
  'libs/core/reasoning/backend-live-scenarios.ts': {
    construction: 'receives',
    reason: 'drives the backend its caller built; defines runBackendLiveScenarios',
  },
  'scripts/check/check_backend_live_scenarios.ts': {
    construction: 'caller-bounded',
    reason: 'operator entry point of the live scenarios',
  },
  'libs/core/testing/reasoning-backend-conformance.ts': {
    construction: 'receives',
    reason:
      'is handed the provider adapter itself; its pre-aborted abort probe refuses failover chains',
  },
  'libs/core/reasoning/model-role-fitness-runner.ts': {
    construction: 'caller-bounded',
    reason: 'builds the role-fitness probe backend and bounds each probe',
  },
  'scripts/evaluate_model_role_fitness.ts': {
    construction: 'receives',
    reason:
      'operator entry point; installs host seams only, the runner builds the measurement backend',
  },
};

const SOURCE_ROOTS = ['libs', 'scripts', 'presence', 'satellites'];
const MEASUREMENT_CALL =
  /\b(?:runBackendLiveScenarios|runReasoningBackendConformance|runModelRoleFitnessProbes)\s*\(/u;
const CONSTRUCTION_CALL = /\b(?:buildTaskReasoningBackend|constructTaskReasoningBackend)\s*\(/gu;
const INSTALLED_CHAIN_CALL = /\bgetReasoningBackend\s*\(/u;
const CALLER_BOUNDED = /requestTimeout\s*:\s*['"]caller['"]/u;

const rootDir = process.cwd();

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:\\])\/\/.*$/, '$1'))
    .join('\n');
}

/** The argument text of each construction call (balanced parentheses). */
function constructionCallArgs(code: string): string[] {
  const args: string[] = [];
  for (const match of code.matchAll(CONSTRUCTION_CALL)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    let end = open;
    for (; end < code.length; end++) {
      if (code[end] === '(') depth++;
      else if (code[end] === ')' && --depth === 0) break;
    }
    args.push(code.slice(open + 1, end));
  }
  return args;
}

/** Violations of the construction rule for one source file. */
function measurementConstructionViolations(source: string, construction: Construction): string[] {
  const code = stripComments(source);
  const violations: string[] = [];
  if (INSTALLED_CHAIN_CALL.test(code)) violations.push('uses the installed chain');
  const calls = constructionCallArgs(code);
  if (construction === 'receives' && calls.length > 0) {
    violations.push('constructs a backend although registered as receives');
  }
  if (construction === 'caller-bounded') {
    if (calls.length === 0) violations.push('constructs no backend');
    if (calls.some((args) => !CALLER_BOUNDED.test(args))) {
      violations.push("constructs a backend without requestTimeout: 'caller'");
    }
  }
  return violations;
}

describe('Measurement backend construction gate', () => {
  it('detects wrapped, installed-chain and unregistered construction shapes', () => {
    expect(
      measurementConstructionViolations(
        "const b = buildTaskReasoningBackend({ mode, requestTimeout: 'caller', timeoutMs: 1 });",
        'caller-bounded'
      )
    ).toEqual([]);
    expect(
      measurementConstructionViolations(
        'const b = buildTaskReasoningBackend({ mode });',
        'caller-bounded'
      )
    ).toEqual(["constructs a backend without requestTimeout: 'caller'"]);
    expect(
      measurementConstructionViolations('const b = getReasoningBackend();', 'caller-bounded')
    ).toEqual(['uses the installed chain', 'constructs no backend']);
    expect(
      measurementConstructionViolations(
        "buildTaskReasoningBackend({ requestTimeout: 'caller' });",
        'receives'
      )
    ).toEqual(['constructs a backend although registered as receives']);
    // Commented-out code does not count.
    expect(measurementConstructionViolations('// getReasoningBackend()', 'receives')).toEqual([]);
  });

  it('keeps every measurement entry point on a caller-bounded backend', () => {
    const found = new Set<string>();
    const violations: Record<string, string[]> = {};
    for (const directory of SOURCE_ROOTS) {
      for (const filePath of getAllFiles(path.join(rootDir, directory))) {
        const relPath = normalize(path.relative(rootDir, filePath));
        if (!/\.(ts|tsx|mts|cts)$/.test(relPath)) continue;
        if (/(^|\/)(node_modules|dist|\.next)\//.test(relPath)) continue;
        if (/\.test\.[cm]?tsx?$/.test(relPath) || /\.d\.ts$/.test(relPath)) continue;
        const source = safeReadFile(filePath, { encoding: 'utf8' }) as string;
        if (!MEASUREMENT_CALL.test(stripComments(source))) continue;
        found.add(relPath);
        const entry = MEASUREMENT_ENTRY_POINTS[relPath];
        const problems = entry
          ? measurementConstructionViolations(source, entry.construction)
          : ['unregistered measurement entry point'];
        if (problems.length > 0) violations[relPath] = problems;
      }
    }
    expect(
      violations,
      'measurement entry point on a wrapped backend — the request wrapper answers aborts and the ' +
        "installed chain's 60s route limit cuts turns, so the run measures the wrapper, not the provider | " +
        "next: build the backend with buildTaskReasoningBackend({ requestTimeout: 'caller', timeoutMs }) and " +
        'bound every call yourself (never getReasoningBackend()), or hand the provider adapter in; ' +
        'register the file with its construction and a reason in MEASUREMENT_ENTRY_POINTS'
    ).toEqual({});
    expect(
      Object.keys(MEASUREMENT_ENTRY_POINTS).filter((file) => !found.has(file)),
      'stale MEASUREMENT_ENTRY_POINTS entry — the file no longer defines or calls a measurement | next: drop the entry'
    ).toEqual([]);
  }, 60000);
});
