#!/usr/bin/env node

import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import {
  markToolRuntimeInstalled,
  probeToolRuntime,
  resolveManagedToolPythonBin,
} from '@agent/core/tool-runtime-registry';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult, safeExistsSync, safeMkdir } from '@agent/core/secure-io';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const TOOL_ID = 'agy_sdk';
const MANAGED_PYTHON_VERSION =
  getRegisteredEnvText('KYBERION_MANAGED_PYTHON_VERSION')?.trim() || '3.11';

type SetupStatus = 'ready' | 'needs_install' | 'unsupported';

interface SetupReport {
  managedEnvPath: string;
  pythonBin: string | null;
  status: SetupStatus;
  detail: string;
}

function resolvePythonCandidates(managedEnvPath: string): string[] {
  if (process.platform === 'win32') {
    return [
      path.join(managedEnvPath, 'Scripts', 'python.exe'),
      path.join(managedEnvPath, 'Scripts', 'python3.exe'),
    ];
  }
  return [path.join(managedEnvPath, 'bin', 'python'), path.join(managedEnvPath, 'bin', 'python3')];
}

function resolvePython(managedEnvPath: string): string | null {
  return (
    resolveManagedToolPythonBin(TOOL_ID) ??
    resolvePythonCandidates(managedEnvPath).find((candidate) => safeExistsSync(candidate)) ??
    null
  );
}

function isHealthy(pythonBin: string | null): boolean {
  if (!pythonBin) return false;
  const version = safeExecResult(
    pythonBin,
    ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")'],
    { timeoutMs: 10_000, maxOutputMB: 1 }
  );
  if (version.status !== 0) return false;
  const [major, minor] = version.stdout.trim().split('.').map(Number);
  if (major < 3 || (major === 3 && minor < 10)) return false;
  const imported = safeExecResult(pythonBin, ['-c', 'import google.antigravity'], {
    timeoutMs: 30_000,
    maxOutputMB: 1,
  });
  return imported.status === 0;
}

function inspect(): SetupReport {
  const resolution = probeToolRuntime(TOOL_ID, 'installed');
  const pythonBin = resolvePython(resolution.managed_env_path);
  if (isHealthy(pythonBin)) {
    return {
      managedEnvPath: resolution.managed_env_path,
      pythonBin,
      status: 'ready',
      detail: 'google-antigravity is installed in the managed Python runtime.',
    };
  }
  return {
    managedEnvPath: resolution.managed_env_path,
    pythonBin,
    status: 'needs_install',
    detail: `Python ${MANAGED_PYTHON_VERSION}+ runtime and google-antigravity require setup.`,
  };
}

function install(): SetupReport {
  const resolution = probeToolRuntime(TOOL_ID, 'approved_install');
  const managedEnvPath = resolution.managed_env_path;
  safeMkdir(managedEnvPath, { recursive: true });

  const pythonBefore = resolvePython(managedEnvPath);
  const versionBefore = pythonBefore
    ? safeExecResult(
        pythonBefore,
        ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")'],
        {
          timeoutMs: 10_000,
          maxOutputMB: 1,
        }
      )
    : null;
  const needsVenv =
    !pythonBefore ||
    versionBefore?.status !== 0 ||
    versionBefore.stdout.trim() !== MANAGED_PYTHON_VERSION;
  if (needsVenv) {
    const venv = safeExecResult(
      'uv',
      ['venv', '--python', MANAGED_PYTHON_VERSION, '--clear', managedEnvPath],
      { cwd: pathResolver.rootDir(), timeoutMs: 120_000, maxOutputMB: 8 }
    );
    if (venv.status !== 0) {
      throw new Error(`uv venv failed: ${venv.stderr || venv.error?.message || 'unknown error'}`);
    }
  }

  const pythonBin = resolvePythonCandidates(managedEnvPath).find((candidate) =>
    safeExistsSync(candidate)
  );
  if (!pythonBin) throw new Error(`Managed Python was not created at ${managedEnvPath}.`);
  const backend = resolution.install_backend;
  const packageName = backend?.args?.[2] || 'google-antigravity';
  const installed = safeExecResult('uv', ['pip', 'install', '--python', pythonBin, packageName], {
    cwd: pathResolver.rootDir(),
    timeoutMs: 300_000,
    maxOutputMB: 32,
  });
  if (installed.status !== 0) {
    throw new Error(
      `uv pip install failed: ${installed.stderr || installed.error?.message || 'unknown error'}`
    );
  }
  markToolRuntimeInstalled(TOOL_ID, {
    action: 'agy_sdk_setup',
    command: 'uv',
    args: ['pip', 'install', '--python', pythonBin, packageName],
    notes: `Managed runtime installed into ${managedEnvPath}`,
  });
  return inspect();
}

export function formatAgySdkReport(report: SetupReport, apply: boolean): string[] {
  const icon =
    report.status === 'ready' ? 'OK' : report.status === 'needs_install' ? 'WARN' : 'SKIP';
  const lines = [
    `[${icon}] ${TOOL_ID}`,
    `  managed_env: ${report.managedEnvPath}`,
    `  detail: ${report.detail}`,
  ];
  if (report.pythonBin) lines.push(`  python: ${report.pythonBin}`);
  if (!apply && report.status === 'needs_install') {
    lines.push('Next step: `pnpm agy:sdk:setup --apply`');
  }
  return lines;
}

export async function main(args: string[] = []): Promise<{ report: SetupReport; apply: boolean }> {
  const argv = await createStandardYargs(['node', 'agy_sdk_setup', ...args])
    .option('apply', { type: 'boolean', default: false })
    .parseSync();
  const current = inspect();
  const report = argv.apply && current.status === 'needs_install' ? install() : current;
  return { report, apply: Boolean(argv.apply) };
}

export { inspect as inspectAgySdkRuntime, install as installAgySdkRuntime };

export const runAgySdkSetup = defineScript({
  name: 'agy:sdk:setup',
  flags: [],
  run: async (context) => {
    const { report, apply } = await main(context.argv);
    context.print(formatAgySdkReport(report, apply).join('\n'));
    if (apply && report.status === 'needs_install') {
      throw new ScriptExitError(1, report.detail);
    }
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'agy_sdk_setup.ts') ||
  isDirectScript(import.meta.url, 'agy_sdk_setup.js')
)
  void runAgySdkSetup();
