import * as path from 'node:path';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import {
  NON_SOURCE_DIRECTORIES,
  SOURCE_SHADOW_EXCEPTIONS,
  SOURCE_TREE_ROOTS,
} from './build-output-layout.js';

/** Physical scan: gitignored and untracked files are deliberately visible. */
export function findSourceShadows(
  root = pathResolver.rootDir(),
  roots: readonly string[] = SOURCE_TREE_ROOTS
): string[] {
  const shadows: string[] = [];
  function walk(directory: string): void {
    if (!safeExistsSync(directory)) return;
    for (const name of safeReaddir(directory).sort()) {
      const file = path.join(directory, name);
      const stat = safeLstat(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (!NON_SOURCE_DIRECTORIES.has(name)) walk(file);
        continue;
      }
      const base = file.replace(/(?:\.d\.[cm]?ts(?:\.map)?|\.[cm]?js(?:\.map)?)$/u, '');
      if (base === file) continue;
      if (!['.ts', '.tsx', '.mts', '.cts'].some((extension) => safeExistsSync(base + extension)))
        continue;
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (!SOURCE_SHADOW_EXCEPTIONS[relative]) shadows.push(relative);
    }
  }
  for (const sourceRoot of roots) walk(path.resolve(root, sourceRoot));
  return shadows.sort();
}

const main = defineScript({
  name: 'check_source_shadows',
  run: async (context) => {
    const shadows = findSourceShadows();
    if (shadows.length)
      throw new ScriptExitError(
        1,
        'Compiled artifacts shadow TypeScript sources: ' + shadows.join(', ')
      );
    context.print('Source shadow check passed (including ignored and untracked files).');
  },
});
if (
  isDirectScript(import.meta.url, 'check_source_shadows.ts') ||
  isDirectScript(import.meta.url, 'check_source_shadows.js')
)
  void main();
