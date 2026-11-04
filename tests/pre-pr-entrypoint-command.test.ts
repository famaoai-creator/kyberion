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
 * pre-pr-ci-readiness-checklist.ja.md "よく落ちる gate".
 */
const root = path.resolve(__dirname, '..');
const read = (relative: string): string =>
  String(safeReadFile(path.join(root, relative), { encoding: 'utf8' }));

const ENTRY_POINTS = [
  'AGENTS.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'knowledge/product/governance/pre-pr-ci-readiness-checklist.ja.md',
  'knowledge/product/orchestration/git-flow-standards.md',
];

describe('pre-PR entry points prescribe the CI-equivalent command', () => {
  for (const file of ENTRY_POINTS) {
    it(`${file} names \`pnpm check -- --changed\` and the affected-tests run`, () => {
      const text = read(file);
      expect(text).toContain('pnpm check -- --changed');
      expect(text).toContain('vitest related');
    });
  }

  it('AGENTS.md and the PR template do not prescribe `--scope pr` as the pre-PR run', () => {
    for (const file of ['AGENTS.md', '.github/PULL_REQUEST_TEMPLATE.md']) {
      expect(read(file), file).not.toMatch(/Run `pnpm check -- --scope pr`/);
      expect(read(file), file).not.toMatch(/^pnpm check -- --scope pr\s*$/m);
    }
  });

  it('the pr create caution text matches what the readiness gate runs', () => {
    const vocabulary = read('knowledge/product/orchestration/user-facing-vocabulary.json');
    expect(vocabulary).not.toContain('runs `pnpm check -- --scope pr` and the knowledge gate');
  });
});
