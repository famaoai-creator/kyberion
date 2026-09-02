#!/usr/bin/env node
/**
 * Run pending migration scripts in order.
 *
 * Migrations live in ./migration and export:
 *   - id
 *   - description
 *   - introduced_in
 *   - migrate({ dryRun })
 *   - optional rollback({ dryRun })
 *
 * The runner persists applied migration ids to
 * active/shared/runtime/migrations.applied.json.
 */

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSafeJsonObjectValue, readJson } from '@agent/core/foundation';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeStat,
  safeWriteFile,
} from '@agent/core/secure-io';
import { createStandardYargs } from '@agent/core/cli-utils';
import { defineScript, isDirectScript } from './lib/harness.js';

interface MigrationModule {
  id: string;
  description?: string;
  introduced_in?: string;
  migrate?: (opts: { dryRun: boolean }) => Promise<void> | void;
  rollback?: (opts: { dryRun: boolean }) => Promise<void> | void;
}

interface MigrationState {
  applied: string[];
}

interface RunnerOptions {
  dir: string;
  statePath: string;
  dryRun: boolean;
  rollback: boolean;
  list: boolean;
}

function resolveMigrationDir(input: string | undefined): string {
  if (!input || input.trim().length === 0) {
    return assertSafeRepositoryPath(pathResolver.rootResolve('migration'), {
      allowMissingLeaf: true,
    });
  }
  return assertSafeRepositoryPath(pathResolver.resolve(input), { allowMissingLeaf: true });
}

function resolveStatePath(input: string | undefined): string {
  if (!input || input.trim().length === 0) {
    return assertSafeRepositoryPath(pathResolver.shared('runtime/migrations.applied.json'), {
      allowMissingLeaf: true,
    });
  }
  return assertSafeRepositoryPath(pathResolver.resolve(input), { allowMissingLeaf: true });
}

function listMigrationFiles(dir: string): string[] {
  const safeDir = assertSafeRepositoryPath(dir, { allowMissingLeaf: true });
  if (!safeExistsSync(safeDir)) return [];
  const entries: string[] = [];
  for (const name of safeReaddir(safeDir)) {
    const filePath = assertSafeRepositoryPath(path.join(safeDir, name));
    const stat = safeStat(filePath);
    if (!stat.isFile()) continue;
    if (!/\.(ts|js|mjs|cjs)$/.test(name)) continue;
    if (!/^\d{4}-[a-z0-9][a-z0-9-_]*\.(ts|js|mjs|cjs)$/i.test(name)) continue;
    entries.push(filePath);
  }
  return entries.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function readState(statePath: string): MigrationState {
  if (!safeExistsSync(statePath)) return { applied: [] };
  if (!safeLstat(statePath).isFile()) {
    throw new Error(`Migration state must be a regular file: ${statePath}`);
  }
  try {
    const parsed = parseSafeJsonObjectValue(readJson<unknown>(statePath), 'migration state');
    const keys = Object.keys(parsed);
    if (keys.some((key) => key !== 'applied') || !Array.isArray(parsed.applied)) {
      return { applied: [] };
    }
    const applied = parsed.applied;
    if (
      applied.some((value) => typeof value !== 'string' || value.trim().length === 0) ||
      new Set(applied).size !== applied.length
    ) {
      return { applied: [] };
    }
    return { applied: [...applied] };
  } catch (err: any) {
    throw new Error(`Failed to read migration state at ${statePath}: ${err?.message ?? err}`);
  }
}

function writeState(statePath: string, state: MigrationState): void {
  safeMkdir(path.dirname(statePath), { recursive: true });
  safeWriteFile(statePath, `${JSON.stringify({ applied: state.applied }, null, 2)}\n`, {
    encoding: 'utf8',
  });
}

async function loadMigrationModule(filePath: string): Promise<MigrationModule> {
  const mod = await import(pathToFileURL(filePath).href);
  const migration = mod.default ?? mod;
  if (!migration || typeof migration.id !== 'string') {
    throw new Error(`Migration module ${path.basename(filePath)} does not export a string id`);
  }
  return migration as MigrationModule;
}

function migrationIdFromFile(filePath: string): string {
  return path.basename(filePath).replace(/\.(ts|js|mjs|cjs)$/i, '');
}

async function runMigration(filePath: string, dryRun: boolean): Promise<MigrationModule> {
  const migration = await loadMigrationModule(filePath);
  if (typeof migration.migrate !== 'function') {
    throw new Error(`Migration ${migration.id} does not export migrate()`);
  }
  logger.info(
    `→ ${dryRun ? 'dry-run ' : ''}migration ${migration.id}: ${migration.description ?? ''}`
  );
  await migration.migrate({ dryRun });
  return migration;
}

async function rollbackMigration(filePath: string, dryRun: boolean): Promise<MigrationModule> {
  const migration = await loadMigrationModule(filePath);
  if (typeof migration.rollback !== 'function') {
    throw new Error(`Migration ${migration.id} does not export rollback()`);
  }
  logger.info(
    `→ ${dryRun ? 'dry-run ' : ''}rollback ${migration.id}: ${migration.description ?? ''}`
  );
  await migration.rollback({ dryRun });
  return migration;
}

export async function runMigrations(
  opts: RunnerOptions
): Promise<{ applied: string[]; pending: string[] }> {
  const migrationDir = assertSafeRepositoryPath(opts.dir, { allowMissingLeaf: true });
  const statePath = assertSafeRepositoryPath(opts.statePath, { allowMissingLeaf: true });
  const files = listMigrationFiles(migrationDir);
  const state = readState(statePath);
  const applied = new Set(state.applied);
  const pendingFiles = files.filter((file) => !applied.has(migrationIdFromFile(file)));
  const pending = pendingFiles.map(migrationIdFromFile);

  if (opts.list) {
    logger.info(`📦 migrations (${files.length})`);
    for (const file of files) {
      const id = migrationIdFromFile(file);
      logger.info(`   - ${id}${applied.has(id) ? ' [applied]' : ''}`);
    }
    return { applied: state.applied, pending };
  }

  if (opts.rollback) {
    const latestAppliedId = [...state.applied].at(-1);
    if (!latestAppliedId) {
      logger.info('No applied migrations to roll back.');
      return { applied: state.applied, pending };
    }
    const targetFile = files.find((file) => migrationIdFromFile(file) === latestAppliedId);
    if (!targetFile) {
      throw new Error(
        `Cannot rollback ${latestAppliedId}: migration script not found in ${migrationDir}`
      );
    }
    await rollbackMigration(targetFile, opts.dryRun);
    if (!opts.dryRun) {
      state.applied = state.applied.filter((id) => id !== latestAppliedId);
      writeState(statePath, state);
    }
    return { applied: state.applied, pending };
  }

  if (pendingFiles.length === 0) {
    logger.info('No pending migrations.');
    return { applied: state.applied, pending };
  }

  for (const file of pendingFiles) {
    const migration = await runMigration(file, opts.dryRun);
    if (!opts.dryRun) {
      state.applied.push(migration.id);
      writeState(statePath, state);
    }
  }

  logger.info(opts.dryRun ? 'Dry-run completed.' : 'Migrations completed.');
  return { applied: state.applied, pending };
}

export async function main(
  args: string[] = [],
  print: (value: unknown) => void = () => undefined
): Promise<void> {
  const argv = await createStandardYargs(['node', 'run_migrations', ...args])
    .option('dir', { type: 'string' })
    .option('state', { type: 'string' })
    .option('dry-run', { type: 'boolean', default: false })
    .option('rollback', { type: 'boolean', default: false })
    .option('list', { type: 'boolean', default: false })
    .parseSync();

  const result = await runMigrations({
    dir: resolveMigrationDir(argv.dir as string | undefined),
    statePath: resolveStatePath(argv.state as string | undefined),
    dryRun: Boolean(argv['dry-run']),
    rollback: Boolean(argv.rollback),
    list: Boolean(argv.list),
  });

  if (result.pending.length > 0 && !argv['dry-run'] && !argv.rollback && !argv.list) {
    logger.info(`Applied ${result.pending.length} migration(s).`);
  }
  print(result);
}

if (
  isDirectScript(import.meta.url, 'run_migrations.ts') ||
  isDirectScript(import.meta.url, 'run_migrations.js')
) {
  void defineScript({
    name: 'migration',
    flags: ['json', 'dry-run', 'quiet'],
    run({ argv, print }) {
      return main(argv, print);
    },
  })();
}

export { main as runMigrationsCli, listMigrationFiles, readState, writeState };
