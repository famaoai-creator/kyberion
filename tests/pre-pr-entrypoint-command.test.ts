import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';

/**
 * The pre-PR command must be the same everywhere a contributor or agent
 * reads it. CI runs the pr gates (pr-gates) AND the full-only gates
 * (lint-and-validate) on every PR; `pnpm check -- --changed` selects both
 * for the diff, `--scope pr` only the first. Entry documents that still
 * prescribed `--scope pr` let full-only gate failures (e.g. the
 * concept-consolidation budgets) reach CI — see
 * pre-pr-ci-readiness-checklist.ja.md "よく落ちる gate". `pr create` /
 * `pr preflight` already run `--changed` (scripts/publish_pull_request.ts).
 */
const root = path.resolve(__dirname, '..');
const read = (relative: string): string =>
  String(safeReadFile(path.join(root, relative), { encoding: 'utf8' }));

/** Every document that tells a contributor what to run before a PR. */
const ENTRY_POINTS = [
  'AGENTS.md',
  'CONTRIBUTING.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'knowledge/product/governance/pre-pr-ci-readiness-checklist.ja.md',
  'knowledge/product/governance/kyberion-development-practices.md',
  'knowledge/product/orchestration/git-flow-standards.md',
];

/**
 * `--scope pr` as *the* pre-PR run (a backticked bare command). Targeted
 * uses such as `pnpm check -- --scope pr --only env-registry` stay legal.
 */
const BARE_SCOPE_PR = /`pnpm (?:run )?check -- --scope pr`|^pnpm (?:run )?check -- --scope pr\s*$/m;

describe('pre-PR entry points prescribe the CI-equivalent command', () => {
  for (const file of ENTRY_POINTS) {
    it(`${file} names \`pnpm check -- --changed\` and the affected-tests run`, () => {
      const text = read(file);
      expect(text).toContain('pnpm check -- --changed');
      expect(text).toMatch(/vitest (?:related|run --changed)/);
    });
  }

  it('AGENTS.md, CONTRIBUTING.md and the PR template do not prescribe bare `--scope pr`', () => {
    for (const file of ['AGENTS.md', 'CONTRIBUTING.md', '.github/PULL_REQUEST_TEMPLATE.md']) {
      expect(read(file), file).not.toMatch(BARE_SCOPE_PR);
    }
  });

  it('the pr create caution text names the command the readiness gate runs', () => {
    const vocabulary = JSON.parse(
      read('knowledge/product/orchestration/user-facing-vocabulary.json')
    ) as unknown;
    const entries: Array<Record<string, string>> = [];
    const walk = (node: unknown, key?: string) => {
      if (!node || typeof node !== 'object') return;
      if (key === 'cli_caution_pr_create') entries.push(node as Record<string, string>);
      for (const [childKey, child] of Object.entries(node)) walk(child, childKey);
    };
    walk(vocabulary);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.en).toContain('pnpm check -- --changed');
      expect(entry.ja).toContain('pnpm check -- --changed');
    }
    // The gate itself: publish_pull_request builds `check -- --changed`.
    expect(read('scripts/publish_pull_request.ts')).toContain("'check', '--', '--changed'");
  });
});
