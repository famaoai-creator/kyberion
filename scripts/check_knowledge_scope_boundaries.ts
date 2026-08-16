/** KS-16: static honesty check for knowledge scope choke points. */
import * as path from 'node:path';
import { getAllFiles } from '@agent/core/fs-utils';
import { safeReadFile } from '@agent/core/secure-io';

const root = process.cwd();
const roots = ['libs', 'scripts', 'presence', 'satellites'];
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const findings: string[] = [];

for (const relativeRoot of roots) {
  const absoluteRoot = path.join(root, relativeRoot);
  for (const file of getAllFiles(absoluteRoot)) {
    if (!sourceExtensions.has(path.extname(file)) || file.includes('/dist/')) continue;
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
    const source = String(safeReadFile(file, { encoding: 'utf8' }) || '');
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    for (const match of withoutComments.matchAll(/\bbuildScopedIndex\s*\(([^)]*)\)/g)) {
      const args = match[1].trim();
      if (!args || args.startsWith(',')) {
        findings.push(`${path.relative(root, file)}: unscoped buildScopedIndex call`);
      }
    }
    for (const match of withoutComments.matchAll(
      /\bgetSurfaceQueryProviderConfig\s*\(([^)]*)\)/g
    )) {
      if (!match[1].trim()) {
        findings.push(
          `${path.relative(root, file)}: surface-query provider resolved without scope context`
        );
      }
    }
    // A literal confidential root is a source-side scope bypass. Dynamic
    // tenant paths are handled by the governed readers and are checked by
    // their own scope tests; this catches accidental global-root readers.
    if (
      /(?:rootResolve|knowledge|path\.join)\s*\([^\n)]*["']knowledge\/confidential["']/.test(
        withoutComments
      ) &&
      !file.includes('/actuators/') &&
      !file.endsWith('/tenant-design-resolver.ts') &&
      !file.endsWith('/creative-design-resolver.ts')
    ) {
      findings.push(
        `${path.relative(root, file)}: direct confidential root read requires a governed scope reader`
      );
    }
  }
}

if (findings.length > 0) {
  console.error('[check_knowledge_scope_boundaries] FAILED');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('[check_knowledge_scope_boundaries] OK');
