import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  evaluatePolicyCategory,
  formatPolicyVerdict,
  isPolicyCategory,
  isPolicyLevel,
  isPolicyPlatform,
  type PolicyCategory,
  type PolicyCategoryFacts,
  type PolicyLevel,
  type PolicyPlatform,
} from './policy-category.js';
import { pathResolver } from '../path-resolver.js';

function factsFor(caseId: string, platform: PolicyPlatform, level: PolicyLevel): PolicyCategoryFacts {
  const [categoryRaw, variant] = caseId.split('/');
  if (!isPolicyCategory(categoryRaw)) {
    throw new Error(`unknown category in case ${caseId}`);
  }
  const category = categoryRaw as PolicyCategory;
  const facts: PolicyCategoryFacts = { category, level, platform };
  if (variant === 'protected') facts.protected_path = true;
  if (category === 'run_command' && level === 'always' && platform !== 'win32') {
    facts.sandboxed = true;
  }
  return facts;
}

describe('policy category matrix (PB-04)', () => {
  it('matches expected.tsv for representative hermetic cells', () => {
    const tsvPath = pathResolver.rootResolve('tests/fixtures/policy-category-matrix/expected.tsv');
    const lines = readFileSync(tsvPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    const header = lines[0]!.split('\t');
    expect(header[0]).toBe('case');
    const columns = header.slice(1);
    for (const line of lines.slice(1)) {
      const [caseId, ...cells] = line.split('\t');
      expect(cells.length).toBe(columns.length);
      columns.forEach((column, index) => {
        const [platformRaw, levelRaw] = column.split('/');
        expect(isPolicyPlatform(platformRaw)).toBe(true);
        expect(isPolicyLevel(levelRaw)).toBe(true);
        const verdict = evaluatePolicyCategory(
          factsFor(caseId!, platformRaw as PolicyPlatform, levelRaw as PolicyLevel)
        );
        expect(formatPolicyVerdict(verdict)).toBe(cells[index]);
      });
    }
  });
});
