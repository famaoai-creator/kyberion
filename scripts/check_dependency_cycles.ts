/**
 * Dependency cycle check — fails when the TypeScript module graph contains a
 * runtime import cycle (strongly connected component with >1 member).
 *
 * Only runtime edges count: `import type`, `export type`, and `import { type X }`
 * members are erased at compile time, and intentional `await import()` cycle
 * breaks (e.g. approval-store -> surface-mission-steering) are load-order safe.
 * Both relative specifiers and `@agent/core/<sub>` self-references resolve into
 * the graph so cycles cannot hide behind package-style specifiers.
 *
 * Invoke: pnpm check:dep-cycles
 */

import { pathResolver } from '@agent/core/path-resolver';
import { readTextFile } from '@agent/core/foundation';
import { safeExistsSync, safeReaddir, safeStat } from '@agent/core/secure-io';
import * as path from 'node:path';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const SCAN_ROOTS = ['libs', 'scripts'];
const SKIP_DIRS = new Set(['dist', 'node_modules']);
const SKIP_SUFFIXES = ['.test.ts', '.d.ts'];
const CORE_PREFIX = 'libs/core/';

function collectFiles(rootAbs: string, repoRel: string, out: string[]): void {
  for (const entry of safeReaddir(rootAbs)) {
    const abs = path.join(rootAbs, entry);
    const rel = repoRel ? `${repoRel}/${entry}` : entry;
    if (safeStat(abs).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) collectFiles(abs, rel, out);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (SKIP_SUFFIXES.some((suffix) => entry.endsWith(suffix))) continue;
    out.push(rel);
  }
}

function candidatePaths(base: string): string[] {
  const stripped = base.replace(/\.(?:js|ts|mjs|cjs|jsx|tsx)$/, '');
  return [`${stripped}.ts`, `${stripped}/index.ts`];
}

function resolveSpecifier(fromRel: string, specifier: string): string | null {
  if (specifier.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
    for (const candidate of candidatePaths(base)) {
      if (safeExistsSync(pathResolver.rootResolve(candidate))) return candidate;
    }
    return null;
  }
  if (specifier.startsWith('@agent/core/')) {
    const sub = specifier.slice('@agent/core/'.length);
    for (const candidate of candidatePaths(`${CORE_PREFIX}${sub}`)) {
      if (safeExistsSync(pathResolver.rootResolve(candidate))) return candidate;
    }
  }
  return null;
}

const EDGE_RE = /(?:import|export)\s+(type\s+)?[\w\s{},*]*?\s+from\s+['"]([^'"]+)['"]/g;
const SIDE_EFFECT_RE = /import\s+['"]([^'"]+)['"]/g;

function runtimeTargets(fileRel: string, source: string): Set<string> {
  const targets = new Set<string>();
  EDGE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EDGE_RE.exec(source))) {
    if (match[1]) continue; // import/export type
    const clause = match[0].match(/(?:import|export)\s+\{([^}]*)\}/);
    if (clause && clause[1].split(',').every((member) => member.trim().startsWith('type '))) {
      continue;
    }
    const resolved = resolveSpecifier(fileRel, match[2]);
    if (resolved && resolved !== fileRel) targets.add(resolved);
  }
  SIDE_EFFECT_RE.lastIndex = 0;
  while ((match = SIDE_EFFECT_RE.exec(source))) {
    const resolved = resolveSpecifier(fileRel, match[1]);
    if (resolved && resolved !== fileRel) targets.add(resolved);
  }
  return targets;
}

/** Tarjan SCC — returns only components that form a real cycle. */
function findCycles(edges: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1 || (edges.get(v) ?? new Set()).has(v)) {
        components.push(component.sort());
      }
    }
  };

  for (const node of edges.keys()) if (!index.has(node)) visit(node);
  return components;
}

export function findRuntimeImportCycles(roots = SCAN_ROOTS): string[][] {
  const files: string[] = [];
  for (const root of roots) collectFiles(pathResolver.rootResolve(root), root, files);
  const edges = new Map<string, Set<string>>();
  for (const file of files) {
    edges.set(file, runtimeTargets(file, readTextFile(pathResolver.rootResolve(file))));
  }
  return findCycles(edges);
}

export const runCheckDependencyCycles = defineScript({
  name: 'check:dep-cycles',
  flags: [],
  run(context): void {
    const cycles = findRuntimeImportCycles();
    if (cycles.length > 0) {
      throw new ScriptExitError(
        1,
        cycles
          .map(
            (component) =>
              `- runtime import cycle (${component.length} modules):\n    ${component.join('\n    ')}`
          )
          .join('\n')
      );
    }
    context.print('[check:dep-cycles] OK');
  },
});

if (
  isDirectScript(import.meta.url, 'check_dependency_cycles.ts') ||
  isDirectScript(import.meta.url, 'check_dependency_cycles.js')
) {
  runCheckDependencyCycles();
}
