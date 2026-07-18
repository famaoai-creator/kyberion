#!/usr/bin/env node

import * as path from 'node:path';
import {
  createStandardYargs,
  markToolRuntimeInstalled,
  pathResolver,
  probeToolRuntime,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
} from '@agent/core';

const VOICE_TOOL_IDS = ['mlx_audio', 'mlx_whisper'] as const;
const MANAGED_PYTHON_VERSION = process.env.KYBERION_MANAGED_PYTHON_VERSION?.trim() || '3.11';

type VoiceToolId = (typeof VOICE_TOOL_IDS)[number];

type VoiceSetupRow = {
  toolId: VoiceToolId;
  managedEnvPath: string;
  installed: boolean;
  installAction: string;
  pythonBin: string | null;
  status: 'ready' | 'needs_install' | 'unsupported';
  detail: string;
};

function resolveManagedPythonPath(managedEnvPath: string): string {
  if (process.platform === 'win32') {
    return path.join(managedEnvPath, 'Scripts', 'python.exe');
  }
  return path.join(managedEnvPath, 'bin', 'python');
}

function resolveManagedPythonCandidates(managedEnvPath: string): string[] {
  if (process.platform === 'win32') {
    return [
      path.join(managedEnvPath, 'Scripts', 'python.exe'),
      path.join(managedEnvPath, 'Scripts', 'python3.exe'),
    ];
  }
  return [
    path.join(managedEnvPath, 'bin', 'python'),
    path.join(managedEnvPath, 'bin', 'python3'),
  ];
}

function resolveManagedPythonBin(toolId: VoiceToolId): string | null {
  const resolution = probeToolRuntime(toolId, 'installed');
  for (const candidate of resolveManagedPythonCandidates(resolution.managed_env_path)) {
    if (safeExistsSync(candidate)) return candidate;
  }
  return null;
}

function isManagedPythonCurrent(pythonBin: string | null): boolean {
  if (!pythonBin) return false;
  const result = safeExecResult(
    pythonBin,
    ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")'],
    { timeoutMs: 10_000, maxOutputMB: 1 },
  );
  return result.status === 0 && result.stdout.trim() === MANAGED_PYTHON_VERSION;
}

function installManagedVoiceRuntime(toolId: VoiceToolId): VoiceSetupRow {
  const resolution = probeToolRuntime(toolId, 'approved_install');
  const backend = resolution.install_backend;
  if (!backend) {
    return {
      toolId,
      managedEnvPath: resolution.managed_env_path,
      installed: false,
      installAction: 'manual',
      pythonBin: resolveManagedPythonBin(toolId),
      status: 'unsupported',
      detail: `No install backend registered for ${toolId}.`,
    };
  }

  if (
    backend.command === 'uv'
    && backend.args?.[0] === 'pip'
    && backend.args?.[1] === 'install'
  ) {
    const rootDir = pathResolver.rootDir();
    safeMkdir(resolution.managed_env_path, { recursive: true });

    const venvArgs = ['venv', '--python', MANAGED_PYTHON_VERSION];
    // An existing runtime may have been created with the old system Python.
    // Recreate only this narrow managed runtime so the TTS package can use its
    // current Qwen3-TTS implementation.
    if (safeExistsSync(resolution.managed_env_path)) venvArgs.push('--clear');
    venvArgs.push(resolution.managed_env_path);
    const venvResult = safeExecResult('uv', venvArgs, {
      cwd: rootDir,
      timeoutMs: 120_000,
      maxOutputMB: 8,
    });
    if (venvResult.status !== 0) {
      throw new Error(`uv venv failed for ${toolId}: ${venvResult.stderr || venvResult.error?.message || 'unknown error'}`);
    }

    const pythonBin = resolveManagedPythonPath(resolution.managed_env_path);
    const installArgs = ['pip', 'install', '--python', pythonBin, ...backend.args.slice(2)];
    const installResult = safeExecResult('uv', installArgs, {
      cwd: rootDir,
      timeoutMs: 300_000,
      maxOutputMB: 32,
    });
    if (installResult.status !== 0) {
      throw new Error(`uv pip install failed for ${toolId}: ${installResult.stderr || installResult.error?.message || 'unknown error'}`);
    }

    markToolRuntimeInstalled(toolId, {
      action: 'voice_setup',
      command: 'uv',
      args: installArgs,
      notes: `Managed runtime installed into ${resolution.managed_env_path}`,
    });

    return {
      toolId,
      managedEnvPath: resolution.managed_env_path,
      installed: true,
      installAction: 'applied',
      pythonBin,
      status: 'ready',
      detail: `Installed into ${resolution.managed_env_path}`,
    };
  }

  const result = safeExecResult(backend.command, backend.args || [], {
    cwd: pathResolver.rootDir(),
    timeoutMs: 300_000,
    maxOutputMB: 32,
  });
  if (result.status !== 0) {
    throw new Error(`${backend.command} ${backend.args?.join(' ') || ''} failed for ${toolId}: ${result.stderr || result.error?.message || 'unknown error'}`);
  }
  markToolRuntimeInstalled(toolId, {
    action: 'voice_setup',
    command: backend.command,
    args: backend.args,
    notes: `Installed via registered backend into ${resolution.managed_env_path}`,
  });
  return {
      toolId,
      managedEnvPath: resolution.managed_env_path,
      installed: true,
      installAction: 'applied',
      pythonBin: resolveManagedPythonBin(toolId),
      status: 'ready',
      detail: `Installed via ${backend.command}`,
    };
}

function inspectVoiceRuntime(toolId: VoiceToolId): VoiceSetupRow {
  const installedResolution = probeToolRuntime(toolId, 'installed');
  const approvedResolution = probeToolRuntime(toolId, 'approved_install');
  const pythonBin = resolveManagedPythonBin(toolId);
  const supported = installedResolution.tool.platforms.includes('any')
    || installedResolution.tool.platforms.includes(process.platform as any);
  if (!supported) {
    return {
      toolId,
      managedEnvPath: installedResolution.managed_env_path,
      installed: false,
      installAction: 'skip',
      pythonBin,
      status: 'unsupported',
      detail: `Unsupported on ${process.platform}`,
    };
  }
  if (pythonBin) {
    const current = isManagedPythonCurrent(pythonBin);
    return {
      toolId,
      managedEnvPath: installedResolution.managed_env_path,
      installed: current,
      installAction: current ? 'none' : 'pending',
      pythonBin,
      status: current ? 'ready' : 'needs_install',
      detail: current
        ? `Managed Python ${MANAGED_PYTHON_VERSION} found at ${pythonBin}`
        : `Managed Python upgrade required: ${MANAGED_PYTHON_VERSION} (found at ${pythonBin})`,
    };
  }
  return {
    toolId,
    managedEnvPath: approvedResolution.managed_env_path,
    installed: false,
    installAction: 'pending',
    pythonBin: null,
    status: 'needs_install',
    detail: approvedResolution.reason,
  };
}

function printReport(rows: VoiceSetupRow[], apply: boolean): void {
  console.log('Voice runtime setup');
  console.log('');
  for (const row of rows) {
    const icon = row.status === 'ready' ? 'OK' : row.status === 'needs_install' ? 'WARN' : 'SKIP';
    console.log(`[${icon}] ${row.toolId}`);
    console.log(`  managed_env: ${row.managedEnvPath}`);
    console.log(`  detail: ${row.detail}`);
    if (row.pythonBin) {
      console.log(`  python: ${row.pythonBin}`);
    }
  }
  console.log('');
  if (!apply && rows.some((row) => row.status === 'needs_install')) {
    console.log('Next step: `pnpm voice:setup --apply`');
  }
  console.log('Verify: `pnpm voice:health`');
  console.log('Meeting/browser adjuncts: `pnpm env:bootstrap --manifest meeting-participation-runtime --apply`');
}

export async function runVoiceSetup(options: { apply: boolean }): Promise<VoiceSetupRow[]> {
  const rows: VoiceSetupRow[] = [];
  for (const toolId of VOICE_TOOL_IDS) {
    const current = inspectVoiceRuntime(toolId);
    if (options.apply && current.status === 'needs_install') {
      rows.push(installManagedVoiceRuntime(toolId));
    } else {
      rows.push(current);
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('apply', { type: 'boolean', default: false })
    .parseSync();

  const rows = await runVoiceSetup({ apply: Boolean(argv.apply) });
  printReport(rows, Boolean(argv.apply));
  if (rows.some((row) => row.status === 'needs_install')) {
    process.exitCode = argv.apply ? 1 : 0;
  }
}

const isDirect = process.argv[1] && /voice_setup\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((error: any) => {
    console.error(error?.message ?? String(error));
    process.exit(1);
  });
}
