#!/usr/bin/env node

import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import { markToolRuntimeInstalled, probeToolRuntime } from '@agent/core/tool-runtime-registry';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult, safeExistsSync, safeMkdir } from '@agent/core/secure-io';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const VOICE_TOOL_IDS = [
  'mlx_audio',
  'mlx_whisper',
  'faster_whisper',
  'kokoro_tts',
  'pocket_tts',
  'ten_vad',
  'silero_vad',
] as const;
const MANAGED_PYTHON_VERSION =
  getRegisteredEnvText('KYBERION_MANAGED_PYTHON_VERSION')?.trim() || '3.11';

type VoiceToolId = (typeof VOICE_TOOL_IDS)[number];

export type VoiceSetupRow = {
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
  return [path.join(managedEnvPath, 'bin', 'python'), path.join(managedEnvPath, 'bin', 'python3')];
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
    { timeoutMs: 10_000, maxOutputMB: 1 }
  );
  return result.status === 0 && result.stdout.trim() === MANAGED_PYTHON_VERSION;
}

function isManagedVoiceRuntimeHealthy(toolId: VoiceToolId, pythonBin: string | null): boolean {
  if (!isManagedPythonCurrent(pythonBin)) return false;
  const imports: Record<VoiceToolId, string> = {
    mlx_audio: 'import mlx_audio',
    mlx_whisper: 'import mlx_whisper',
    faster_whisper: 'import faster_whisper',
    kokoro_tts: 'import kokoro, soundfile, unidic_lite',
    pocket_tts: 'import pocket_tts, scipy',
    ten_vad: 'import numpy, ten_vad',
    silero_vad: 'import numpy, onnxruntime',
  };
  const result = safeExecResult(pythonBin!, ['-c', imports[toolId]], {
    timeoutMs: 30_000,
    maxOutputMB: 1,
  });
  return result.status === 0;
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

  if (backend.command === 'uv' && backend.args?.[0] === 'pip' && backend.args?.[1] === 'install') {
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
      throw new Error(
        `uv venv failed for ${toolId}: ${venvResult.stderr || venvResult.error?.message || 'unknown error'}`
      );
    }

    const pythonBin = resolveManagedPythonPath(resolution.managed_env_path);
    const installArgs = ['pip', 'install', '--python', pythonBin, ...backend.args.slice(2)];
    const installResult = safeExecResult('uv', installArgs, {
      cwd: rootDir,
      timeoutMs: 300_000,
      maxOutputMB: 32,
    });
    if (installResult.status !== 0) {
      throw new Error(
        `uv pip install failed for ${toolId}: ${installResult.stderr || installResult.error?.message || 'unknown error'}`
      );
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
    throw new Error(
      `${backend.command} ${backend.args?.join(' ') || ''} failed for ${toolId}: ${result.stderr || result.error?.message || 'unknown error'}`
    );
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
  const supported =
    installedResolution.tool.platforms.includes('any') ||
    installedResolution.tool.platforms.includes(process.platform as any);
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
    const current = isManagedVoiceRuntimeHealthy(toolId, pythonBin);
    return {
      toolId,
      managedEnvPath: installedResolution.managed_env_path,
      installed: current,
      installAction: current ? 'none' : 'pending',
      pythonBin,
      status: current ? 'ready' : 'needs_install',
      detail: current
        ? `Managed Python ${MANAGED_PYTHON_VERSION} and ${toolId} dependencies found at ${pythonBin}`
        : `Managed Python or ${toolId} dependencies require setup (found at ${pythonBin})`,
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

export function formatVoiceSetupReport(rows: VoiceSetupRow[], apply: boolean): string[] {
  const lines = ['Voice runtime setup', ''];
  for (const row of rows) {
    const icon = row.status === 'ready' ? 'OK' : row.status === 'needs_install' ? 'WARN' : 'SKIP';
    lines.push(`[${icon}] ${row.toolId}`);
    lines.push(`  managed_env: ${row.managedEnvPath}`);
    lines.push(`  detail: ${row.detail}`);
    if (row.pythonBin) {
      lines.push(`  python: ${row.pythonBin}`);
    }
  }
  lines.push('');
  if (!apply && rows.some((row) => row.status === 'needs_install')) {
    lines.push('Next step: `pnpm kyberion voice setup --apply`');
  }
  lines.push('Verify: `pnpm pipeline voice-health-check`');
  lines.push(
    'Meeting/browser adjuncts: `pnpm env:bootstrap --manifest meeting-participation-runtime --apply`'
  );
  return lines;
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

export async function main(
  args: string[] = []
): Promise<{ rows: VoiceSetupRow[]; apply: boolean }> {
  const argv = await createStandardYargs(['node', 'voice_setup', ...args])
    .option('apply', { type: 'boolean', default: false })
    .parseSync();

  const rows = await runVoiceSetup({ apply: Boolean(argv.apply) });
  return { rows, apply: Boolean(argv.apply) };
}

export const runVoiceSetupScript = defineScript({
  name: 'voice setup',
  flags: ['json', 'quiet'],
  run: async (context) => {
    const { rows, apply } = await main(context.argv);
    if (context.json) {
      context.print({
        status: rows.some((row) => row.status === 'needs_install') ? 'needs_install' : 'ready',
        apply,
        rows,
      });
    } else {
      context.print(formatVoiceSetupReport(rows, apply).join('\n'));
    }
    if (apply && rows.some((row) => row.status === 'needs_install')) {
      throw new ScriptExitError(1, 'voice runtime setup is incomplete');
    }
    return rows;
  },
});

if (
  isDirectScript(import.meta.url, 'voice_setup.ts') ||
  isDirectScript(import.meta.url, 'voice_setup.js')
)
  void runVoiceSetupScript();
