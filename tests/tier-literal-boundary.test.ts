import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

/**
 * Boundary rule: the 3-element knowledge-tier literal
 * (['public','confidential','personal'] in any order) must not be redeclared
 * outside the canonical sources — KNOWLEDGE_TIERS / STORAGE_DATA_TIERS cover
 * every use (see canonical-registry-consolidation.md). Different vocabularies
 * (e.g. with 'ephemeral', 'shared', 'product', 'unknown', 'external',
 * 'system') are intentionally out of scope.
 */
const CANONICAL = new Set([
  'libs/core/foundation/knowledge-tier.ts', // declares KNOWLEDGE_TIERS itself
]);

describe('knowledge-tier literal boundary', () => {
  it('no source file redeclares the 3-element tier literal', () => {
    const out = execSync(
      "grep -rlnE \"\\[(\\s*'(personal|confidential|public)'\\s*,){2}\\s*'(personal|confidential|public)'\\s*\\]\" libs/core libs/actuators --include='*.ts' || true",
      { cwd: process.cwd(), encoding: 'utf8' }
    );
    const offenders = out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.endsWith('.test.ts') && !CANONICAL.has(line));
    // Each remaining literal must contain exactly the tier set — multi-element
    // vocabularies are matched by the regex prefix and filtered here.
    const real = offenders.filter((file) => {
      const src = execSync(`cat '${file}'`, { cwd: process.cwd(), encoding: 'utf8' });
      const literals = src.match(/\[[^\]]*'(personal|confidential|public)'[^\]]*\]/g) ?? [];
      return literals.some((lit) => {
        const vals = new Set([...lit.matchAll(/'(\w+)'/g)].map((m) => m[1]));
        return (
          vals.size === 3 && vals.has('personal') && vals.has('confidential') && vals.has('public')
        );
      });
    });
    expect(real).toEqual([]);
  });
});
