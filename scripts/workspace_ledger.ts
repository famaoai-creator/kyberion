#!/usr/bin/env node
/**
 * WS-07 workspace ledger CLI.
 *
 *   kyberion workspace list [--json]
 *   kyberion workspace gc [--dry-run | --apply] [--json]
 *
 * `gc` is dry-run unless `--apply` is given, and deletes only ledger-registered
 * orphans (the same sweep the storage janitor runs).
 */
import {
  sweepWorkspaces,
  type SweepWorkspacesOptions,
  type SweepWorkspacesResult,
} from '@agent/core/storage-janitor';
import {
  listUnregisteredWorkspaceDirs,
  listWorkspaces,
  type WorkspaceLedgerOptions,
  type WorkspaceRecord,
} from '@agent/core/workspace-ledger';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const USAGE =
  'Usage: kyberion workspace <list|gc> [--json]\n' +
  '  list                 show registered workspaces and unregistered directories\n' +
  '  gc [--dry-run]       report orphaned workspaces (default)\n' +
  '  gc --apply           delete orphaned registered workspaces';

export interface WorkspaceListResult {
  workspaces: WorkspaceRecord[];
  unregisteredDirs: string[];
}

export interface WorkspaceGcResult {
  dryRun: boolean;
  registered: number;
  orphaned: string[];
  deleted: string[];
  unregisteredDirs: string[];
  errors: string[];
}

export type WorkspaceCliOptions = Omit<SweepWorkspacesOptions, 'dryRun'>;

function renderList(result: WorkspaceListResult): string {
  const lines = result.workspaces.map(
    (record) => `${record.id}  ${record.kind}  ${record.live ? 'live' : 'released'}  ${record.path}`
  );
  if (lines.length === 0) lines.push('(no registered workspaces)');
  for (const dir of result.unregisteredDirs) lines.push(`unregistered  ${dir}`);
  return lines.join('\n');
}

function summarizeGc(dryRun: boolean, result: SweepWorkspacesResult): WorkspaceGcResult {
  return {
    dryRun,
    registered: result.registered,
    orphaned: result.orphaned.map((record) => record.id),
    deleted: result.deleted.map((record) => record.id),
    unregisteredDirs: result.unregisteredDirs,
    errors: result.errors,
  };
}

function renderGc(result: WorkspaceGcResult): string {
  const lines = [
    `${result.dryRun ? '[dry-run] ' : ''}registered=${result.registered} orphaned=${result.orphaned.length} deleted=${result.deleted.length}`,
    ...result.orphaned.map((id) => `orphan  ${id}`),
    ...result.unregisteredDirs.map((dir) => `unregistered  ${dir}`),
    ...result.errors.map((error) => `error  ${error}`),
  ];
  if (result.dryRun && result.orphaned.length > 0) lines.push('re-run with --apply to delete');
  return lines.join('\n');
}

export function runWorkspaceLedgerCli(
  args: { positional: string[]; json: boolean; dryRun: boolean },
  print: (value: unknown) => void,
  options: WorkspaceCliOptions = {}
): WorkspaceListResult | WorkspaceGcResult {
  const [verb, ...rest] = args.positional;
  if (verb === 'list') {
    const unknown = rest.filter((arg) => arg !== '--');
    if (unknown.length > 0)
      throw new ScriptExitError(2, `unknown arguments: ${unknown.join(' ')}\n${USAGE}`);
    const ledger: WorkspaceLedgerOptions = {
      ledgerPath: options.ledgerPath,
      allowedRoots: options.allowedRoots,
    };
    const result: WorkspaceListResult = {
      workspaces: listWorkspaces(ledger),
      unregisteredDirs: listUnregisteredWorkspaceDirs(ledger),
    };
    print(args.json ? result : renderList(result));
    return result;
  }
  if (verb === 'gc') {
    const apply = rest.includes('--apply');
    const unknown = rest.filter((arg) => arg !== '--apply' && arg !== '--');
    if (unknown.length > 0)
      throw new ScriptExitError(2, `unknown arguments: ${unknown.join(' ')}\n${USAGE}`);
    if (apply && args.dryRun) throw new ScriptExitError(2, '--apply and --dry-run are exclusive');
    const dryRun = !apply;
    const result = summarizeGc(dryRun, sweepWorkspaces({ ...options, dryRun }));
    print(args.json ? result : renderGc(result));
    if (result.errors.length > 0) throw new ScriptExitError(1, '', true, result);
    return result;
  }
  throw new ScriptExitError(2, USAGE);
}

export const runWorkspaceLedger = defineScript({
  name: 'workspace',
  flags: ['json', 'dry-run', 'quiet'],
  run: ({ positional, json, dryRun, print }) =>
    runWorkspaceLedgerCli({ positional, json, dryRun }, print),
});

if (
  isDirectScript(import.meta.url, 'workspace_ledger.ts') ||
  isDirectScript(import.meta.url, 'workspace_ledger.js')
) {
  void runWorkspaceLedger();
}
