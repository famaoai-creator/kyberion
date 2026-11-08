import path from 'node:path';

import { pathResolver, toRepoRelative } from '@agent/core/path-resolver';
import { readJson } from '@agent/core/foundation';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';

/**
 * Read-only catalog of the repository's ADF pipelines — every `.json` under
 * `pipelines/`, recursively. Shared fragments are include-only building
 * blocks — never runnable directly — so they stay out of the picker.
 */

export interface PipelineCatalogEntry {
  /** Repo-relative path, e.g. `pipelines/daily-routine.json`. */
  path: string;
  name: string;
  description: string;
  version?: string;
  /** Declared op ids, for the picker detail. */
  ops: string[];
  stepCount: number;
  /** The ADF declares its own schedule trigger. */
  hasSchedule: boolean;
  /** The JSON parsed but is not an ADF pipeline contract. */
  notPipeline?: boolean;
  /** The JSON failed to parse — surfaced so a broken file is visible. */
  parseError?: boolean;
}

const SKIP_DIRS = new Set(['fragments']);

function collectPipelineJsonFiles(dir: string, found: string[] = []): string[] {
  if (!safeExistsSync(dir)) return found;
  for (const name of safeReaddir(dir).sort()) {
    const full = path.join(dir, name);
    const stat = safeLstat(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(name)) collectPipelineJsonFiles(full, found);
    } else if (name.endsWith('.json')) {
      found.push(full);
    }
  }
  return found;
}

function stepOps(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  return steps
    .map((step) => (step && typeof step === 'object' ? (step as { op?: unknown }).op : undefined))
    .filter((op): op is string => typeof op === 'string' && op.length > 0);
}

/**
 * Repo-relative path of `absolutePath` under `rootDir`. Files outside the
 * root (never produced by `listPipelineCatalog`, but tolerated for direct
 * callers) fall back to the repository-root relativization.
 */
function catalogRelative(absolutePath: string, rootDir: string): string {
  const rel = path.relative(rootDir, absolutePath).split(path.sep).join('/');
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : toRepoRelative(absolutePath);
}

export function describePipelineFile(absolutePath: string, rootDir: string): PipelineCatalogEntry {
  const relative = catalogRelative(absolutePath, rootDir);
  const base: PipelineCatalogEntry = {
    path: relative,
    name: path.basename(relative, '.json'),
    description: '',
    ops: [],
    stepCount: 0,
    hasSchedule: false,
  };
  let parsed: unknown;
  try {
    parsed = readJson<unknown>(absolutePath);
  } catch {
    return { ...base, parseError: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...base, notPipeline: true };
  }
  const record = parsed as Record<string, unknown>;
  if (record.action !== 'pipeline' || !Array.isArray(record.steps)) {
    return { ...base, notPipeline: true };
  }
  const ops = stepOps(record.steps);
  return {
    ...base,
    name: typeof record.name === 'string' && record.name.trim() ? record.name : base.name,
    description: typeof record.description === 'string' ? record.description : '',
    version: typeof record.version === 'string' ? record.version : undefined,
    ops: [...new Set(ops)],
    stepCount: record.steps.length,
    hasSchedule: Boolean(record.schedule && typeof record.schedule === 'object'),
  };
}

export function listPipelineCatalog(rootDir = pathResolver.rootDir()): PipelineCatalogEntry[] {
  const pipelinesRoot = assertSafeRepositoryPath(path.join(rootDir, 'pipelines'), {
    allowMissingLeaf: true,
    rootDir,
  });
  return collectPipelineJsonFiles(pipelinesRoot)
    .map((file) => describePipelineFile(file, rootDir))
    .sort((a, b) => a.path.localeCompare(b.path));
}
