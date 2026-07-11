import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import {
  applyDependencyPatch,
  bumpDependencySpec,
  type PatchCommandResult,
  type PatchExecRunner,
} from './apply_dependency_patch.js';

const TMP_ROOT = pathResolver.active('shared/tmp/tests');

let testRoot: string;
let ledgerPath: string;
let backupRoot: string;

function writeRootPackage(spec: Record<string, unknown>): void {
  safeWriteFile(path.join(testRoot, 'package.json'), `${JSON.stringify(spec, null, 2)}\n`);
}

function readRootPackage(): Record<string, any> {
  return JSON.parse(
    safeReadFile(path.join(testRoot, 'package.json'), { encoding: 'utf8' }) as string
  );
}

function readLedgerRecords(): Array<Record<string, any>> {
  if (!safeExistsSync(ledgerPath)) return [];
  return (safeReadFile(ledgerPath, { encoding: 'utf8' }) as string)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

class FakeRunner implements PatchExecRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly respond: (command: string, args: string[]) => PatchCommandResult) {}

  run(command: string, args: string[]): PatchCommandResult {
    this.calls.push({ command, args });
    return this.respond(command, args);
  }
}

const ok: PatchCommandResult = { status: 0, stdout: '', stderr: '' };
const cleanAudit: PatchCommandResult = {
  status: 0,
  stdout: JSON.stringify({ vulnerabilities: {} }),
  stderr: '',
};

const GATES = [
  { name: 'install', command: 'pnpm', args: ['install', '--no-frozen-lockfile'] },
  { name: 'typecheck', command: 'pnpm', args: ['run', 'typecheck'] },
  { name: 'smoke', command: 'pnpm', args: ['test'] },
];

beforeEach(() => {
  safeMkdir(TMP_ROOT, { recursive: true });
  testRoot = path.join(
    TMP_ROOT,
    `patch-apply-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  safeMkdir(testRoot, { recursive: true });
  ledgerPath = path.join(testRoot, 'vuln-ledger.jsonl');
  backupRoot = path.join(testRoot, 'backups');
  writeRootPackage({ dependencies: { leftpad: '^1.0.0' }, devDependencies: { tsx: '4.0.0' } });
});

afterEach(() => {
  const relative = path.relative(TMP_ROOT, testRoot);
  if (relative.startsWith('..') || !relative.startsWith('patch-apply-test-')) {
    throw new Error(`Refusing to clean non-isolated patch test path: ${testRoot}`);
  }
  safeRmSync(testRoot, { recursive: true, force: true });
});

describe('bumpDependencySpec', () => {
  it('preserves the range operator and finds devDependencies', () => {
    const pkg = readRootPackage();
    expect(bumpDependencySpec(pkg, 'leftpad', '1.0.1')).toEqual({
      section: 'dependencies',
      previous: '^1.0.0',
      next: '^1.0.1',
    });
    expect(bumpDependencySpec(pkg, 'tsx', '4.1.0')).toEqual({
      section: 'devDependencies',
      previous: '4.0.0',
      next: '4.1.0',
    });
    expect(bumpDependencySpec(pkg, 'not-a-dep', '1.0.0')).toBeNull();
  });
});

describe('applyDependencyPatch', () => {
  it('propose mode records the plan without touching files', () => {
    const runner = new FakeRunner(() => ok);
    const outcome = applyDependencyPatch({
      packageName: 'leftpad',
      targetVersion: '1.0.1',
      apply: false,
      rootDir: testRoot,
      ledgerPath,
      backupRoot,
      runner,
      gates: GATES,
    });

    expect(outcome.status).toBe('proposed');
    expect(runner.calls).toHaveLength(0);
    expect(readRootPackage().dependencies.leftpad).toBe('^1.0.0');
    const records = readLedgerRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'patch_apply', mode: 'propose', status: 'proposed' });
  });

  it('applies, gates, rescans, and confirms on green', () => {
    const runner = new FakeRunner((command, args) => (args[0] === 'audit' ? cleanAudit : ok));
    const outcome = applyDependencyPatch({
      packageName: 'leftpad',
      targetVersion: '1.0.1',
      apply: true,
      rootDir: testRoot,
      ledgerPath,
      backupRoot,
      runner,
      gates: GATES,
    });

    expect(outcome.status).toBe('patched');
    expect(readRootPackage().dependencies.leftpad).toBe('^1.0.1');
    expect(runner.calls.map((call) => call.args[0] ?? call.command)).toEqual([
      'install',
      'run',
      'test',
      'audit',
    ]);
    expect(outcome.gates).toEqual([
      { name: 'install', passed: true },
      { name: 'typecheck', passed: true },
      { name: 'smoke', passed: true },
      { name: 'vuln_rescan', passed: true },
    ]);
    // Backup snapshot preserved for §3.4 traceability.
    expect(outcome.backup_dir).toBeTruthy();
    const backupPkg = JSON.parse(
      safeReadFile(path.join(String(outcome.backup_dir), 'package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(backupPkg.dependencies.leftpad).toBe('^1.0.0');
  });

  it('rolls back and escalates when a gate fails', () => {
    const runner = new FakeRunner((command, args) =>
      args[0] === 'run' ? { status: 1, stdout: '', stderr: 'type error' } : ok
    );
    const outcome = applyDependencyPatch({
      packageName: 'leftpad',
      targetVersion: '1.0.1',
      apply: true,
      rootDir: testRoot,
      ledgerPath,
      backupRoot,
      runner,
      gates: GATES,
    });

    expect(outcome.status).toBe('rolled_back');
    expect(outcome.reason).toContain("Gate 'typecheck' failed");
    expect(readRootPackage().dependencies.leftpad).toBe('^1.0.0');
    // Rollback re-runs install to regenerate the lockfile.
    const installCalls = runner.calls.filter((call) => call.args[0] === 'install');
    expect(installCalls).toHaveLength(2);
    const records = readLedgerRecords();
    expect(records.at(-1)).toMatchObject({ status: 'rolled_back', mode: 'apply' });
  });

  it('rolls back when the rescan still reports the package', () => {
    const dirtyAudit: PatchCommandResult = {
      status: 1,
      stdout: JSON.stringify({ vulnerabilities: { leftpad: { severity: 'high' } } }),
      stderr: '',
    };
    const runner = new FakeRunner((command, args) => (args[0] === 'audit' ? dirtyAudit : ok));
    const outcome = applyDependencyPatch({
      packageName: 'leftpad',
      targetVersion: '1.0.1',
      apply: true,
      rootDir: testRoot,
      ledgerPath,
      backupRoot,
      runner,
      gates: GATES,
    });

    expect(outcome.status).toBe('rolled_back');
    expect(outcome.gates.at(-1)).toEqual({ name: 'vuln_rescan', passed: false });
    expect(readRootPackage().dependencies.leftpad).toBe('^1.0.0');
  });

  it('refuses transitive-only dependencies and escalates to approval', () => {
    const runner = new FakeRunner(() => ok);
    const outcome = applyDependencyPatch({
      packageName: 'deep-transitive-dep',
      targetVersion: '2.0.0',
      apply: true,
      rootDir: testRoot,
      ledgerPath,
      backupRoot,
      runner,
      gates: GATES,
    });

    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toContain('--override');
    expect(runner.calls).toHaveLength(0);
    expect(readLedgerRecords().at(-1)).toMatchObject({ mode: 'refused' });
  });

  it('patches a transitive dependency via pnpm.overrides when --override is set', () => {
    const runner = new FakeRunner((command, args) => (args[0] === 'audit' ? cleanAudit : ok));
    const outcome = applyDependencyPatch({
      packageName: 'deep-transitive-dep',
      targetVersion: '2.0.0',
      apply: true,
      allowOverride: true,
      rootDir: testRoot,
      ledgerPath,
      backupRoot,
      runner,
      gates: GATES,
    });

    expect(outcome.status).toBe('patched');
    expect(outcome.section).toBe('pnpm.overrides');
    expect(outcome.previous_spec).toBe('(none)');
    expect(readRootPackage().pnpm.overrides['deep-transitive-dep']).toBe('2.0.0');
    // Direct deps stay untouched.
    expect(readRootPackage().dependencies.leftpad).toBe('^1.0.0');
  });

  it('rolls back an override patch when a gate fails', () => {
    const runner = new FakeRunner((command, args) =>
      args[1] === 'test' || command === 'pnpm'
        ? args[0] === 'test'
          ? { status: 1, stdout: 'smoke failed', stderr: '' }
          : args[0] === 'audit'
            ? cleanAudit
            : ok
        : ok
    );
    const outcome = applyDependencyPatch({
      packageName: 'deep-transitive-dep',
      targetVersion: '2.0.0',
      apply: true,
      allowOverride: true,
      rootDir: testRoot,
      ledgerPath,
      backupRoot,
      runner,
      gates: GATES,
    });

    expect(outcome.status).toBe('rolled_back');
    expect(readRootPackage().pnpm).toBeUndefined();
  });
});
