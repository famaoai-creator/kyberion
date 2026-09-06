import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { readTextFile } from '@agent/core/foundation';
import { safeExistsSync } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';
import { defineScript, isDirectScript } from './lib/harness.js';

export type ResourceLoaderKind = 'readJson' | 'readJsonLines' | 'readTextFile';
export type ResourceLoaderReviewStatus = 'inline-safe-path' | 'nearby-path-guard' | 'needs-review';

export interface ResourceLoaderCallSite {
  file: string;
  line: number;
  loader: ResourceLoaderKind;
  status: ResourceLoaderReviewStatus;
  evidence: string[];
}

export interface ResourceLoaderInventory {
  roots: string[];
  files: number;
  callsites: ResourceLoaderCallSite[];
  counts: Record<ResourceLoaderReviewStatus, number>;
}

export interface ResourceLoaderSourceOptions {
  externalRegularFileHelpers?: ReadonlySet<string>;
}

const DEFAULT_ROOTS = ['libs/core', 'satellites', 'presence'];
const LOADER_PATTERN = /\b(readJsonLines|readJson|readTextFile)(?:<[^\n;>]+>)?\s*\(/gu;
const DECLARATION_PATTERN =
  /^\s*(?:export\s+)?(?:async\s+)?function\s+(?:readJsonLines|readJson|readTextFile)(?:<[^>\n]+>)?\s*\(|^\s*(?:const|let|var)\s+(?:readJsonLines|readJson|readTextFile)\s*=|^\s*(?:async\s+)?(?:readJsonLines|readJson|readTextFile)(?:<[^>\n]+>)?\s*\(/u;
const EVIDENCE_PATTERNS: readonly [string, RegExp][] = [
  ['assertSafeRepositoryPath', /\bassertSafeRepositoryPath\s*\(/u],
  ['safeOptionalRepositoryPath', /\bsafeOptionalRepositoryPath\s*\(/u],
  ['safeLstat', /\bsafeLstat\s*\(/u],
  ['safeStat', /\bsafeStat\s*\(/u],
  ['assertRegular', /\bassertRegular[A-Za-z]*\s*\(/u],
  ['ensureRegular', /\bensureRegular[A-Za-z]*\s*\(/u],
  ['readSafeJson', /\breadSafeJson[A-Za-z]*\s*\(/u],
  ['safeReadFile', /\bsafeReadFile\s*\(/u],
];
const GUARD_LOOKBACK_LINES = 32;

function stripQuotedText(line: string): string {
  return line
    .replace(/'(?:\\.|[^'\\])*'/gu, '')
    .replace(/"(?:\\.|[^"\\])*"/gu, '')
    .replace(/`(?:\\.|[^`\\])*`/gu, '');
}

function braceDelta(line: string): number {
  let delta = 0;
  for (const token of stripQuotedText(line).match(/\{|\}/gu) || []) {
    delta += token === '{' ? 1 : -1;
  }
  return delta;
}

/**
 * Find local helpers whose implementation actually checks the final resource
 * type. A helper named `safePath` is not enough evidence by itself: the body
 * must contain a regular-file check. This keeps the inventory fail-closed for
 * path-only helpers while avoiding repeated false positives for domain helpers
 * such as `regularJournalPath` and `ensureDurableQueueFile`.
 */
function collectRegularFileHelperNames(source: string): Set<string> {
  const lines = source.split(/\r?\n/u);
  const names = new Set<string>();
  const declarations = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)(?:<[^>\n]+>)?\s*\([^)]*\)[^{]*\{/u,
    /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/u,
    /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/u,
    /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/u,
    /^\s*(?:(?:public|private|protected|static|async|readonly)\s+)+([A-Za-z_$][\w$]*)(?:<[^>\n]+>)?\s*\([^)]*\)[^{]*\{/u,
  ];
  for (let index = 0; index < lines.length; index += 1) {
    const match = declarations.map((pattern) => lines[index].match(pattern)).find(Boolean);
    const name = match?.[1] || match?.[2];
    if (!name) continue;
    let depth = 0;
    let body = '';
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      body += `\n${lines[cursor]}`;
      depth += braceDelta(lines[cursor]);
      if (cursor > index && depth <= 0) break;
    }
    if (
      /\b(?:safeLstat|safeStat)\s*\([^)]*\)\s*\.isFile\s*\(\)/u.test(body) ||
      /\b(?:assertRegular|ensureRegular)[A-Za-z_$\d]*\s*\(/u.test(body)
    ) {
      names.add(name);
    }
  }
  return names;
}

function resolveRelativeImportSource(
  importer: string,
  specifier: string,
  sourceByFile: ReadonlyMap<string, string>
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/u, '.ts'),
    base.replace(/\.mjs$/u, '.ts'),
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
  ];
  return candidates.find((candidate) => sourceByFile.has(candidate));
}

/**
 * Resolve only named relative imports whose target module proves a
 * regular-file check in the helper body. Package/barrel imports remain
 * unclassified so the inventory does not turn a name match into false safety
 * evidence without seeing the implementation.
 */
export function collectImportedRegularFileHelperNames(
  importer: string,
  source: string,
  sourceByFile: ReadonlyMap<string, string>
): Set<string> {
  const names = new Set<string>();
  const importPattern = /import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/gu;
  for (const match of source.matchAll(importPattern)) {
    const bindings = match[1];
    const specifier = match[2];
    const importedFile = resolveRelativeImportSource(importer, specifier, sourceByFile);
    if (!importedFile) continue;
    const targetNames = collectRegularFileHelperNames(sourceByFile.get(importedFile) ?? '');
    for (const binding of bindings.split(',')) {
      const normalized = binding.replace(/\btype\s+/u, '').trim();
      if (!normalized) continue;
      const [imported, local = imported] = normalized
        .split(/\s+as\s+/u)
        .map((value) => value.trim());
      if (targetNames.has(imported)) names.add(local);
    }
  }
  return names;
}

function toRepoRelative(filePath: string): string {
  return path.relative(pathResolver.rootDir(), filePath).split(path.sep).join('/');
}

function isLoaderDeclaration(line: string): boolean {
  return DECLARATION_PATTERN.test(line);
}

function nearbyEvidence(
  lines: readonly string[],
  lineIndex: number,
  regularFileHelpers: ReadonlySet<string>,
  externalRegularFileHelpers: ReadonlySet<string>
): string[] {
  const start = Math.max(0, lineIndex - GUARD_LOOKBACK_LINES);
  const window = lines.slice(start, lineIndex + 1).join('\n');
  const evidence = EVIDENCE_PATTERNS.filter(([, pattern]) => pattern.test(window)).map(
    ([name]) => name
  );
  for (const helper of regularFileHelpers) {
    const escapedHelper = helper.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (new RegExp(`\\b${escapedHelper}(?:<[^>\\n]+>)?\\s*\\(`, 'u').test(window)) {
      evidence.push(`regular-file-helper:${helper}`);
    }
  }
  for (const helper of externalRegularFileHelpers) {
    const escapedHelper = helper.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (new RegExp(`\\b${escapedHelper}(?:<[^>\\n]+>)?\\s*\\(`, 'u').test(window)) {
      evidence.push(`external-regular-file-helper:${helper}`);
    }
  }
  return [...new Set(evidence)];
}

export function scanResourceLoaderSource(
  file: string,
  source: string,
  options: ResourceLoaderSourceOptions = {}
): ResourceLoaderCallSite[] {
  const lines = source.split(/\r?\n/u);
  const regularFileHelpers = collectRegularFileHelperNames(source);
  const externalRegularFileHelpers = options.externalRegularFileHelpers ?? new Set<string>();
  const callsites: ResourceLoaderCallSite[] = [];
  for (const [index, line] of lines.entries()) {
    if (isLoaderDeclaration(line)) continue;
    for (const match of line.matchAll(LOADER_PATTERN)) {
      const loader = match[1] as ResourceLoaderKind;
      const inline = line.slice(match.index).includes('assertSafeRepositoryPath(');
      const evidence = inline
        ? ['assertSafeRepositoryPath']
        : nearbyEvidence(lines, index, regularFileHelpers, externalRegularFileHelpers);
      callsites.push({
        file,
        line: index + 1,
        loader,
        status: inline
          ? 'inline-safe-path'
          : evidence.length > 0
            ? 'nearby-path-guard'
            : 'needs-review',
        evidence,
      });
    }
  }
  return callsites;
}

function sourceFiles(roots: readonly string[]): string[] {
  return roots
    .map((root) => pathResolver.rootResolve(root))
    .filter((root) => safeExistsSync(root))
    .flatMap((root) => getAllFiles(root))
    .filter((file) => {
      const normalized = file.split(path.sep).join('/');
      return (
        file.endsWith('.ts') &&
        !file.endsWith('.test.ts') &&
        !normalized.includes('/node_modules/') &&
        !normalized.includes('/dist/') &&
        !normalized.includes('/.next/') &&
        !normalized.includes('/coverage/') &&
        !toRepoRelative(file).startsWith('libs/core/foundation/')
      );
    })
    .sort((a, b) => a.localeCompare(b));
}

export function buildResourceLoaderInventory(
  roots: readonly string[] = DEFAULT_ROOTS
): ResourceLoaderInventory {
  const files = sourceFiles(roots);
  const sourceByFile = new Map(files.map((file) => [file, readTextFile(file)]));
  const callsites = files.flatMap((file) =>
    scanResourceLoaderSource(toRepoRelative(file), sourceByFile.get(file) ?? '', {
      externalRegularFileHelpers: collectImportedRegularFileHelperNames(
        file,
        sourceByFile.get(file) ?? '',
        sourceByFile
      ),
    })
  );
  const counts: Record<ResourceLoaderReviewStatus, number> = {
    'inline-safe-path': 0,
    'nearby-path-guard': 0,
    'needs-review': 0,
  };
  for (const callsite of callsites) counts[callsite.status] += 1;
  return { roots: [...roots], files: files.length, callsites, counts };
}

export const runInventoryResourceLoaders = defineScript({
  name: 'inventory:resource-loaders',
  flags: ['json'],
  run(context) {
    const inventory = buildResourceLoaderInventory();
    if (context.json) {
      context.print(inventory);
      return inventory;
    }
    context.print(
      `[inventory:resource-loaders] files=${inventory.files} callsites=${inventory.callsites.length}`
    );
    context.print(
      `[inventory:resource-loaders] inline=${inventory.counts['inline-safe-path']} nearby=${inventory.counts['nearby-path-guard']} needs-review=${inventory.counts['needs-review']}`
    );
    for (const callsite of inventory.callsites.filter((entry) => entry.status === 'needs-review')) {
      context.print(`- ${callsite.file}:${callsite.line} ${callsite.loader}`);
    }
    return inventory;
  },
});

if (
  isDirectScript(import.meta.url, 'inventory_resource_loaders.ts') ||
  isDirectScript(import.meta.url, 'inventory_resource_loaders.js')
)
  void runInventoryResourceLoaders();
