import * as path from 'node:path';
import { validateFacetPurity } from '@agent/core/facet-registry';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile, safeReaddir } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const roots = [
  ['persona', pathResolver.knowledge('product/facets/personas')],
  ['policy', pathResolver.knowledge('product/facets/policies')],
  ['instruction', pathResolver.knowledge('product/facets/instructions')],
  ['output-contract', pathResolver.knowledge('product/facets/output-contracts')],
] as const;

export function checkFacetPurity(): string[] {
  const violations: string[] = [];
  for (const [kind, root] of roots) {
    if (!safeExistsSync(root)) continue;
    for (const file of safeReaddir(root)
      .filter((entry) => entry.endsWith('.md'))
      .sort()) {
      const filePath = path.join(root, file);
      const errors = validateFacetPurity({
        kind,
        content: safeReadFile(filePath, { encoding: 'utf8' }) as string,
      });
      for (const error of errors) violations.push(`${filePath}: ${error}`);
    }
  }
  return violations;
}

export const runCheckFacetPurity = defineScript({
  name: 'check:facet-purity',
  flags: [],
  run(context) {
    const violations = checkFacetPurity();
    if (violations.length > 0) {
      for (const violation of violations) context.print(violation);
      throw new ScriptExitError(1);
    }
    context.print('[check:facet-purity] passed');
    return { violations };
  },
});

if (
  isDirectScript(import.meta.url, 'check_facet_purity.ts') ||
  isDirectScript(import.meta.url, 'check_facet_purity.js')
)
  void runCheckFacetPurity();
