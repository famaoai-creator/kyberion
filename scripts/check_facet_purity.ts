import * as path from 'node:path';
import {
  pathResolver,
  safeExistsSync,
  safeReadFile,
  safeReaddir,
  validateFacetPurity,
} from '@agent/core';

const roots = [
  ['persona', pathResolver.knowledge('product/facets/personas')],
  ['policy', pathResolver.knowledge('product/facets/policies')],
  ['instruction', pathResolver.knowledge('product/facets/instructions')],
  ['output-contract', pathResolver.knowledge('product/facets/output-contracts')],
] as const;

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

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('[check:facet-purity] passed');
}
