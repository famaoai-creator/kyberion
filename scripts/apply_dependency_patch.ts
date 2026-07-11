/**
 * apply_dependency_patch.ts — AO-02 Task 3: governed dependency patch flow.
 *
 * Implements the AUTONOMOUS_MAINTENANCE_JUDGMENT §3.4 sequence for a single
 * direct dependency:
 *
 *   backup → apply version bump → install + typecheck + smoke gate →
 *   vulnerability rescan → green: confirm + ledger / red: rollback + escalate
 *
 * Default mode is **propose** (warn-observation posture): no files change,
 * the plan and rubric decision are printed and recorded in the vuln ledger.
 * Pass --apply to execute the flow. Transitive-only dependencies are refused
 * and escalated to approval (v1 patches direct deps only).
 *
 * Rollback restores package.json from the backup and re-runs pnpm install to
 * regenerate the lockfile (pnpm-lock.yaml itself is only ever written by the
 * pnpm subprocess).
 *
 * Usage:
 *   pnpm patch:dependency -- --package <name> --to <version>          # propose
 *   pnpm patch:dependency -- --package <name> --to <version> --apply  # execute
 */

import * as path from 'node:path';
import {
  createStandardYargs,
  logger,
  pathResolver,
  safeAppendFileSync,
  safeExecResult,
  safeExistsSync,
  safeJsonParse,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';

export interface PatchCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface PatchExecRunner {
  run(command: string, args: string[], options?: { cwd?: string }): PatchCommandResult;
}

export interface DependencyPatchOptions {
  packageName: string;
  targetVersion: string;
  apply: boolean;
  rootDir?: string;
  ledgerPath?: string;
  backupRoot?: string;
  runner?: PatchExecRunner;
  /** Gate commands run in order after the version bump. */
  gates?: Array<{ name: string; command: string; args: string[] }>;
}

export interface DependencyPatchOutcome {
  status: 'proposed' | 'patched' | 'rolled_back' | 'refused';
  package_name: string;
  previous_spec?: string;
  next_spec?: string;
  section?: string;
  gates: Array<{ name: string; passed: boolean }>;
  backup_dir?: string;
  reason: string;
}

interface RootPackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

const DEFAULT_LEDGER_PATH = pathResolver.active('shared/runtime/vuln-ledger.jsonl');

const defaultRunner: PatchExecRunner = {
  run(command, args, options = {}) {
    const result = safeExecResult(command, args, {
      cwd: options.cwd,
      maxOutputMB: 20,
      timeoutMs: 15 * 60_000,
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  },
};

function defaultGates(): Array<{ name: string; command: string; args: string[] }> {
  return [
    { name: 'install', command: 'pnpm', args: ['install', '--no-frozen-lockfile'] },
    { name: 'typecheck', command: 'pnpm', args: ['run', 'typecheck'] },
    { name: 'smoke', command: 'pnpm', args: ['test'] },
  ];
}

/**
 * Compute the updated dependency spec, preserving the range operator of the
 * existing spec (`^`/`~` prefixes carry over; anything else becomes exact).
 */
export function bumpDependencySpec(
  pkg: RootPackageJson,
  packageName: string,
  targetVersion: string
): { section: 'dependencies' | 'devDependencies'; previous: string; next: string } | null {
  for (const section of ['dependencies', 'devDependencies'] as const) {
    const previous = pkg[section]?.[packageName];
    if (!previous) continue;
    const operator = /^[\^~]/.test(previous) ? previous[0] : '';
    return { section, previous, next: `${operator}${targetVersion}` };
  }
  return null;
}

function appendLedger(ledgerPath: string, record: Record<string, unknown>): void {
  safeMkdir(path.dirname(ledgerPath), { recursive: true });
  safeAppendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
}

function auditStillVulnerable(auditStdout: string, packageName: string): boolean {
  try {
    const audit = safeJsonParse<{ vulnerabilities?: Record<string, unknown> }>(
      auditStdout.trim() || '{}',
      'pnpm audit json'
    );
    return Boolean(audit.vulnerabilities && packageName in audit.vulnerabilities);
  } catch {
    // Unparseable audit output is treated as "still vulnerable" — the
    // fail-closed reading keeps a broken rescan from confirming a patch.
    return true;
  }
}

export function applyDependencyPatch(options: DependencyPatchOptions): DependencyPatchOutcome {
  const rootDir = options.rootDir || pathResolver.rootDir();
  const ledgerPath = options.ledgerPath || DEFAULT_LEDGER_PATH;
  const runner = options.runner || defaultRunner;
  const gates = options.gates || defaultGates();
  const packageJsonPath = path.join(rootDir, 'package.json');
  const timestamp = new Date().toISOString();

  const pkg = safeJsonParse<RootPackageJson>(
    safeReadFile(packageJsonPath, { encoding: 'utf8' }) as string,
    'root package.json'
  );
  const bump = bumpDependencySpec(pkg, options.packageName, options.targetVersion);

  if (!bump) {
    const outcome: DependencyPatchOutcome = {
      status: 'refused',
      package_name: options.packageName,
      gates: [],
      reason:
        'Not a direct dependency of the root package — transitive patches need a pnpm override and go through approval (AO-02 §3.4 handoff).',
    };
    appendLedger(ledgerPath, { kind: 'patch_apply', timestamp, mode: 'refused', ...outcome });
    return outcome;
  }

  if (!options.apply) {
    const outcome: DependencyPatchOutcome = {
      status: 'proposed',
      package_name: options.packageName,
      previous_spec: bump.previous,
      next_spec: bump.next,
      section: bump.section,
      gates: [],
      reason: 'Proposal only (run with --apply to execute the §3.4 flow).',
    };
    appendLedger(ledgerPath, { kind: 'patch_apply', timestamp, mode: 'propose', ...outcome });
    return outcome;
  }

  // 1. Backup (package.json snapshot; the lockfile is regenerated on rollback).
  const backupDir = path.join(
    options.backupRoot || pathResolver.active('shared/tmp/patch-backups'),
    timestamp.replace(/[:.]/g, '-')
  );
  safeMkdir(backupDir, { recursive: true });
  const packageJsonRaw = safeReadFile(packageJsonPath, { encoding: 'utf8' }) as string;
  safeWriteFile(path.join(backupDir, 'package.json'), packageJsonRaw);

  // 2. Apply the version bump.
  const nextPkg: RootPackageJson = safeJsonParse(packageJsonRaw, 'root package.json');
  nextPkg[bump.section] = { ...nextPkg[bump.section], [options.packageName]: bump.next };
  safeWriteFile(packageJsonPath, `${JSON.stringify(nextPkg, null, 2)}\n`);

  const gateResults: Array<{ name: string; passed: boolean }> = [];
  const rollback = (failedGate: string, detail: string): DependencyPatchOutcome => {
    safeWriteFile(packageJsonPath, packageJsonRaw);
    const reinstall = runner.run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: rootDir });
    const outcome: DependencyPatchOutcome = {
      status: 'rolled_back',
      package_name: options.packageName,
      previous_spec: bump.previous,
      next_spec: bump.next,
      section: bump.section,
      gates: gateResults,
      backup_dir: backupDir,
      reason:
        `Gate '${failedGate}' failed — rolled back and escalated to approval. ${detail}`.trim(),
    };
    appendLedger(ledgerPath, {
      kind: 'patch_apply',
      timestamp,
      mode: 'apply',
      rollback_reinstall_status: reinstall.status,
      ...outcome,
    });
    return outcome;
  };

  // 3. Gates: install + typecheck + smoke.
  for (const gate of gates) {
    const result = runner.run(gate.command, gate.args, { cwd: rootDir });
    const passed = result.status === 0;
    gateResults.push({ name: gate.name, passed });
    if (!passed) {
      return rollback(gate.name, (result.stderr || result.stdout).slice(-400));
    }
  }

  // 4. Vulnerability rescan for the patched package.
  const rescan = runner.run('pnpm', ['audit', '--json'], { cwd: rootDir });
  const stillVulnerable = auditStillVulnerable(rescan.stdout, options.packageName);
  gateResults.push({ name: 'vuln_rescan', passed: !stillVulnerable });
  if (stillVulnerable) {
    return rollback('vuln_rescan', 'Package still reported by pnpm audit after the bump.');
  }

  // 5. Confirm.
  const outcome: DependencyPatchOutcome = {
    status: 'patched',
    package_name: options.packageName,
    previous_spec: bump.previous,
    next_spec: bump.next,
    section: bump.section,
    gates: gateResults,
    backup_dir: backupDir,
    reason: 'All gates green; patch confirmed.',
  };
  appendLedger(ledgerPath, { kind: 'patch_apply', timestamp, mode: 'apply', ...outcome });
  return outcome;
}

async function main(): Promise<number> {
  const argv = createStandardYargs()
    .option('package', { type: 'string', demandOption: true, describe: 'Direct dependency name' })
    .option('to', {
      type: 'string',
      demandOption: true,
      describe: 'Target version (exact, e.g. 1.2.3)',
    })
    .option('apply', {
      type: 'boolean',
      default: false,
      describe: 'Execute the flow (default proposes only)',
    })
    .parseSync();

  const outcome = withExecutionContext('ecosystem_architect', () =>
    applyDependencyPatch({
      packageName: String(argv.package),
      targetVersion: String(argv.to),
      apply: Boolean(argv.apply),
    })
  );

  console.log(JSON.stringify(outcome, null, 2));
  if (outcome.status === 'patched' || outcome.status === 'proposed') {
    logger.success(`[patch] ${outcome.package_name}: ${outcome.status}`);
    return 0;
  }
  logger.error(`[patch] ${outcome.package_name}: ${outcome.status} — ${outcome.reason}`);
  return 1;
}

const isDirect = process.argv[1] && /apply_dependency_patch\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      logger.error(`[patch] failed: ${(error as Error).message || error}`);
      process.exit(1);
    }
  );
}
