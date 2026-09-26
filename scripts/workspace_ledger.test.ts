import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { registerWorkspace, releaseWorkspace } from '@agent/core/workspace-ledger';
import { ScriptExitError } from './lib/harness.js';
import {
  runWorkspaceLedgerCli,
  type WorkspaceCliOptions,
  type WorkspaceGcResult,
  type WorkspaceListResult,
} from './workspace_ledger.js';

let base: string;
let options: WorkspaceCliOptions;
let printed: unknown[];
const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const print = (value: unknown) => printed.push(value);

function seed(): { orphanPath: string; livePath: string; stray: string } {
  const root = path.join(base, 'workspaces');
  const orphanPath = path.join(root, 'orphan');
  const livePath = path.join(root, 'live');
  const stray = path.join(root, 'stray');
  safeWriteFile(path.join(orphanPath, 'f.txt'), 'x');
  safeWriteFile(path.join(livePath, 'f.txt'), 'x');
  safeMkdir(stray, { recursive: true });
  const releasedAt = new Date(NOW - 48 * 60 * 60 * 1000);
  const ledger = { ledgerPath: options.ledgerPath, allowedRoots: options.allowedRoots };
  const orphan = registerWorkspace(
    { path: orphanPath, kind: 'scratch-dir', owner: {} },
    { ...ledger, now: () => releasedAt }
  );
  releaseWorkspace(orphan.id, { ...ledger, now: () => releasedAt });
  registerWorkspace({ path: livePath, kind: 'scratch-dir', owner: { session_id: 's' } }, ledger);
  return { orphanPath, livePath, stray };
}

beforeEach(() => {
  base = pathResolver.sharedTmp(`vitest-ws-cli/${randomUUID()}`);
  printed = [];
  options = {
    ledgerPath: path.join(base, 'workspaces', 'ledger.json'),
    allowedRoots: [path.join(base, 'workspaces')],
    now: () => NOW,
    orphanTtlHours: 24,
    isOwnerTerminal: () => false,
  };
  safeMkdir(path.join(base, 'workspaces'), { recursive: true });
});

afterEach(() => {
  safeRmSync(base, { recursive: true, force: true });
});

describe('workspace_ledger CLI', () => {
  it('lists registered workspaces and unregistered directories as JSON', () => {
    const { stray } = seed();
    const result = runWorkspaceLedgerCli(
      { positional: ['list'], json: true, dryRun: false },
      print,
      options
    ) as WorkspaceListResult;
    expect(result.workspaces).toHaveLength(2);
    expect(result.unregisteredDirs).toEqual([stray]);
    expect(printed).toEqual([result]);
  });

  it('gc defaults to dry-run and deletes nothing', () => {
    const { orphanPath } = seed();
    const result = runWorkspaceLedgerCli(
      { positional: ['gc'], json: false, dryRun: false },
      print,
      options
    ) as WorkspaceGcResult;
    expect(result.dryRun).toBe(true);
    expect(result.orphaned).toHaveLength(1);
    expect(result.deleted).toEqual([]);
    expect(fs.existsSync(orphanPath)).toBe(true);
    expect(String(printed[0])).toContain('--apply');
  });

  it('gc --apply deletes only registered orphans', () => {
    const { orphanPath, livePath, stray } = seed();
    const result = runWorkspaceLedgerCli(
      { positional: ['gc', '--apply'], json: true, dryRun: false },
      print,
      options
    ) as WorkspaceGcResult;
    expect(result.dryRun).toBe(false);
    expect(result.deleted).toHaveLength(1);
    expect(fs.existsSync(orphanPath)).toBe(false);
    expect(fs.existsSync(livePath)).toBe(true);
    expect(fs.existsSync(stray)).toBe(true);
  });

  it('rejects unknown verbs, unknown arguments and --apply with --dry-run', () => {
    expect(() =>
      runWorkspaceLedgerCli({ positional: ['prune'], json: false, dryRun: false }, print, options)
    ).toThrow(ScriptExitError);
    expect(() =>
      runWorkspaceLedgerCli(
        { positional: ['gc', '--force'], json: false, dryRun: false },
        print,
        options
      )
    ).toThrow(/unknown arguments/);
    expect(() =>
      runWorkspaceLedgerCli(
        { positional: ['gc', '--apply'], json: false, dryRun: true },
        print,
        options
      )
    ).toThrow(/exclusive/);
  });
});
