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
} from '@agent/core/workforce/workspace-ledger';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

const USAGE =
  'Usage: kyberion workspace <list|gc> [--json]\n' +
  '  list                 show registered workspaces and unregistered directories\n' +
  '  gc [--dry-run]       report orphaned workspaces (default)\n' +
  '  gc --apply [--only <workspace-id>]  delete eligible registered orphans\n' +
  '  gc --apply --include-unresolvable-owners\n' +
  '                       also reclaim workspaces whose mission owner no longer resolves (3x TTL; not from a tenant-bound process)';

export interface WorkspaceListResult {
  workspaces: WorkspaceRecord[];
  unregisteredDirs: string[];
}

export interface WorkspaceGcResult {
  dryRun: boolean;
  selectedWorkspaceId?: string;
  selectionStatus?: 'not_found' | 'not_eligible' | 'eligible' | 'deleted' | 'error';
  registered: number;
  orphaned: string[];
  deleted: string[];
  unregisteredDirs: string[];
  unresolvedOwners: string[];
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
    unresolvedOwners: result.unresolvedOwners.map((record) => record.id),
    errors: result.errors,
  };
}

function renderGc(result: WorkspaceGcResult): string {
  const lines = [
    `${result.dryRun ? '[dry-run] ' : ''}registered=${result.registered} orphaned=${result.orphaned.length} deleted=${result.deleted.length}`,
    ...(result.selectedWorkspaceId
      ? [`workspace: ${result.selectedWorkspaceId} (${result.selectionStatus})`]
      : []),
    ...result.orphaned.map((id) => `orphan  ${id}`),
    ...result.unregisteredDirs.map((dir) => `unregistered  ${dir}`),
    ...result.unresolvedOwners.map((id) => `owner-unresolvable  ${id}`),
    ...result.errors.map((error) => `error  ${error}`),
  ];
  if (result.dryRun && result.orphaned.length > 0)
    lines.push('Use --apply --only <workspace-id> to remove one reviewed orphan.');
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
    const optionIndex = rest.indexOf('--only');
    const workspaceId = optionIndex >= 0 ? rest[optionIndex + 1] : undefined;
    if (optionIndex >= 0 && (!workspaceId || workspaceId.startsWith('--')))
      throw new ScriptExitError(2, '--only requires a workspace ID');
    if (workspaceId) rest.splice(optionIndex, 2);
    const apply = rest.includes('--apply');
    const includeUnresolvable = rest.includes('--include-unresolvable-owners');
    const unknown = rest.filter(
      (arg) => arg !== '--apply' && arg !== '--include-unresolvable-owners' && arg !== '--'
    );
    if (unknown.length > 0)
      throw new ScriptExitError(2, `unknown arguments: ${unknown.join(' ')}\n${USAGE}`);
    if (apply && args.dryRun) throw new ScriptExitError(2, '--apply and --dry-run are exclusive');
    const dryRun = !apply;
    const result = summarizeGc(
      dryRun,
      sweepWorkspaces({
        ...options,
        dryRun,
        ...(workspaceId ? { workspaceId } : {}),
        sweepUnresolvableOwners: options.sweepUnresolvableOwners ?? includeUnresolvable,
      })
    );
    if (workspaceId) {
      result.selectedWorkspaceId = workspaceId;
      result.selectionStatus = result.errors.length
        ? 'error'
        : result.deleted.includes(workspaceId)
          ? 'deleted'
          : result.orphaned.includes(workspaceId)
            ? 'eligible'
            : result.registered
              ? 'not_eligible'
              : 'not_found';
    }
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
