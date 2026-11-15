import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanGovernanceImportBaseline } from '../scripts/generate/generate_governance_import_baseline.ts';

const rootDir = process.cwd();
const baselinePath = path.join(rootDir, 'tests', 'fixtures', 'governance-import-baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
  fs_imports: string[];
  child_process_imports: string[];
};

function normalize(list: string[]): string[] {
  return [...list].sort((a, b) => a.localeCompare(b));
}

function diffMessage(kind: string, expected: string[], actual: string[]): string {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const added = actual.filter((item) => !expectedSet.has(item));
  const removed = expected.filter((item) => !actualSet.has(item));

  return [
    `${kind} baseline changed.`,
    added.length ? `Added:\n${added.join('\n')}` : 'Added:\n(none)',
    removed.length ? `Removed:\n${removed.join('\n')}` : 'Removed:\n(none)',
    'If intentional, run `pnpm generate:governance-import-baseline` and commit the fixture.',
  ].join('\n\n');
}

describe('Governance import baseline', () => {
  it('does not introduce new direct fs imports without updating the baseline', () => {
    const actual = scanGovernanceImportBaseline().fs_imports;
    const expected = normalize(baseline.fs_imports);
    expect(actual, diffMessage('Direct fs import', expected, actual)).toEqual(expected);
  }, 60_000);

  it('does not introduce new direct child_process imports without updating the baseline', () => {
    const actual = scanGovernanceImportBaseline().child_process_imports;
    const expected = normalize(baseline.child_process_imports);
    expect(actual, diffMessage('Direct child_process import', expected, actual)).toEqual(expected);
  }, 60_000);
});
