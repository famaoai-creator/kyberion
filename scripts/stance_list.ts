#!/usr/bin/env node
import * as path from 'node:path';
import { classifyError, formatClassification } from '@agent/core/error-classifier';
import { STANCES_DIR, activeStance } from '@agent/core/stance-resolver';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';
import { STANCE_REQUIRED_FILES } from './stance_switch.js';

interface StanceEntry {
  slug: string;
  path: string;
  active: boolean;
  ready: boolean;
  missing: string[];
}

export function listStances(): StanceEntry[] {
  const rootDir = pathResolver.rootDir();
  const stancesRoot = assertSafeRepositoryPath(path.join(rootDir, STANCES_DIR), {
    allowMissingLeaf: true,
    rootDir,
  });
  if (!safeExistsSync(stancesRoot) || !safeLstat(stancesRoot).isDirectory()) {
    return [];
  }

  const current = activeStance() ?? null;
  const entries: StanceEntry[] = [];

  for (const entry of safeReaddir(stancesRoot).sort()) {
    const full = assertSafeRepositoryPath(path.join(stancesRoot, entry), {
      allowMissingLeaf: true,
      rootDir,
    });
    if (!safeLstat(full).isDirectory()) continue;
    const missing = STANCE_REQUIRED_FILES.filter((required) => {
      const requiredPath = path.join(full, required);
      return !safeExistsSync(requiredPath) || !safeLstat(requiredPath).isFile();
    });
    entries.push({
      slug: entry,
      path: path.relative(pathResolver.rootDir(), full),
      active: entry === current,
      ready: missing.length === 0,
      missing,
    });
  }

  return entries;
}

export function printText(entries: StanceEntry[]): string[] {
  if (entries.length === 0) {
    return ['No stances found.'];
  }

  return entries.map((entry) => {
    const status = entry.ready ? 'ready' : `missing ${entry.missing.join(', ')}`;
    return `${entry.active ? '* ' : '  '}${entry.slug}\t${status}\t${entry.path}`;
  });
}

export const main = defineScript({
  name: 'stance:list',
  flags: ['json'],
  run(context) {
    try {
      const entries = listStances();
      if (context.json) context.print(entries);
      else context.print(printText(entries).join('\n'));
    } catch (err) {
      throw new Error(formatClassification(classifyError(err)));
    }
  },
});

if (
  isDirectScript(import.meta.url, 'stance_list.ts') ||
  isDirectScript(import.meta.url, 'stance_list.js')
) {
  void main();
}
