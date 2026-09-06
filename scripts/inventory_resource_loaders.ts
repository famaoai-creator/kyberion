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

const DEFAULT_ROOTS = ['libs/core', 'satellites', 'presence'];
const LOADER_PATTERN = /\b(readJsonLines|readJson|readTextFile)(?:<[^\n;>]+>)?\s*\(/gu;
const DECLARATION_PATTERN =
  /^\s*(?:export\s+)?(?:async\s+)?function\s+(?:readJsonLines|readJson|readTextFile)\s*\(|^\s*(?:const|let|var)\s+(?:readJsonLines|readJson|readTextFile)\s*=|^\s*(?:async\s+)?(?:readJsonLines|readJson|readTextFile)\s*\(/u;
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

function toRepoRelative(filePath: string): string {
  return path.relative(pathResolver.rootDir(), filePath).split(path.sep).join('/');
}

function isLoaderDeclaration(line: string): boolean {
  return DECLARATION_PATTERN.test(line);
}

function nearbyEvidence(lines: readonly string[], lineIndex: number): string[] {
  const start = Math.max(0, lineIndex - GUARD_LOOKBACK_LINES);
  const window = lines.slice(start, lineIndex + 1).join('\n');
  return EVIDENCE_PATTERNS.filter(([, pattern]) => pattern.test(window)).map(([name]) => name);
}

export function scanResourceLoaderSource(file: string, source: string): ResourceLoaderCallSite[] {
  const lines = source.split(/\r?\n/u);
  const callsites: ResourceLoaderCallSite[] = [];
  for (const [index, line] of lines.entries()) {
    if (isLoaderDeclaration(line)) continue;
    for (const match of line.matchAll(LOADER_PATTERN)) {
      const loader = match[1] as ResourceLoaderKind;
      const inline = line.slice(match.index).includes('assertSafeRepositoryPath(');
      const evidence = inline ? ['assertSafeRepositoryPath'] : nearbyEvidence(lines, index);
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
  const callsites = files.flatMap((file) =>
    scanResourceLoaderSource(toRepoRelative(file), readTextFile(file))
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
