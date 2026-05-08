import { beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core';
import { runMigrations } from './run_migrations.js';

const TMP_ROOT = pathResolver.sharedTmp('run-migrations-tests');
const MIGRATIONS_DIR = path.join(TMP_ROOT, 'migration');
const STATE_PATH = path.join(TMP_ROOT, 'active/shared/runtime/migrations.applied.json');

function writeMigration(fileName: string, body: string): void {
  safeMkdir(MIGRATIONS_DIR, { recursive: true });
  safeWriteFile(path.join(MIGRATIONS_DIR, fileName), body, { encoding: 'utf8' });
}

function readState(): { applied: string[] } {
  return JSON.parse(String(safeReadFile(STATE_PATH, { encoding: 'utf8' }) || '{"applied":[]}'));
}

describe('run_migrations', () => {
  beforeEach(() => {
    safeRmSync(TMP_ROOT, { recursive: true, force: true });
    (globalThis as any).__migrationCalls = [];
  });

  it('runs pending migrations in order and persists applied state', async () => {
    writeMigration(
      '0001-alpha.ts',
      `
function calls() { return globalThis.__migrationCalls ?? (globalThis.__migrationCalls = []); }
export const id = '0001-alpha';
export const description = 'alpha';
export const introduced_in = 'v0.2.0';
export async function migrate(opts) { calls().push(['migrate', id, opts.dryRun]); }
`,
    );
    writeMigration(
      '0002-beta.ts',
      `
function calls() { return globalThis.__migrationCalls ?? (globalThis.__migrationCalls = []); }
export const id = '0002-beta';
export const description = 'beta';
export const introduced_in = 'v0.2.0';
export async function migrate(opts) { calls().push(['migrate', id, opts.dryRun]); }
export async function rollback(opts) { calls().push(['rollback', id, opts.dryRun]); }
`,
    );

    const result = await runMigrations({
      dir: MIGRATIONS_DIR,
      statePath: STATE_PATH,
      dryRun: false,
      rollback: false,
      list: false,
    });

    expect(result.applied).toEqual(['0001-alpha', '0002-beta']);
    expect(readState().applied).toEqual(['0001-alpha', '0002-beta']);
    expect((globalThis as any).__migrationCalls).toEqual([
      ['migrate', '0001-alpha', false],
      ['migrate', '0002-beta', false],
    ]);
  });

  it('skips already-applied migrations and rolls back the latest one only', async () => {
    writeMigration(
      '0001-alpha.ts',
      `
function calls() { return globalThis.__migrationCalls ?? (globalThis.__migrationCalls = []); }
export const id = '0001-alpha';
export const description = 'alpha';
export const introduced_in = 'v0.2.0';
export async function migrate(opts) { calls().push(['migrate', id, opts.dryRun]); }
export async function rollback(opts) { calls().push(['rollback', id, opts.dryRun]); }
`,
    );
    writeMigration(
      '0002-beta.ts',
      `
function calls() { return globalThis.__migrationCalls ?? (globalThis.__migrationCalls = []); }
export const id = '0002-beta';
export const description = 'beta';
export const introduced_in = 'v0.2.0';
export async function migrate(opts) { calls().push(['migrate', id, opts.dryRun]); }
export async function rollback(opts) { calls().push(['rollback', id, opts.dryRun]); }
`,
    );
    safeMkdir(path.dirname(STATE_PATH), { recursive: true });
    safeWriteFile(STATE_PATH, JSON.stringify({ applied: ['0001-alpha', '0002-beta'] }), {
      encoding: 'utf8',
    });

    const dryRun = await runMigrations({
      dir: MIGRATIONS_DIR,
      statePath: STATE_PATH,
      dryRun: true,
      rollback: true,
      list: false,
    });

    expect(dryRun.applied).toEqual(['0001-alpha', '0002-beta']);
    expect(readState().applied).toEqual(['0001-alpha', '0002-beta']);
    expect((globalThis as any).__migrationCalls).toEqual([['rollback', '0002-beta', true]]);
  });
});
