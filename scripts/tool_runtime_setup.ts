#!/usr/bin/env node
/**
 * Governed install/inspect surface for system tool-runtime entries
 * (Herdr, ImageSnap, BlackHole, …).
 *
 *   pnpm tool:setup -- --tool herdr
 *   pnpm tool:setup -- --tool herdr --apply
 *   pnpm tool:setup -- --tools herdr,imagesnap,blackhole-2ch --apply
 *   pnpm tool:setup -- --list
 *
 * Tools that declare a `managed_binary` (e.g. lightpanda) install the
 * checksum-pinned upstream release into their managed env first; the
 * package-manager `install_backend` is only the fallback for hosts without a
 * matching artifact.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { createStandardYargs } from '@agent/core/cli-utils';
import { logger } from '@agent/core/core';
import { secureFetch } from '@agent/core/network';
import {
  findInstalledManagedBinary,
  getToolRuntimeRecord,
  listToolRuntimes,
  markToolRuntimeInstalled,
  probeToolRuntime,
  resolveManagedBinaryArtifact,
  resolveManagedBinaryPath,
  resolveManagedToolPythonBin,
} from '@agent/core/tool/tool-runtime-registry';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeChmodSync,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeMoveSync,
  safeUnlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { resetLocalSttDiscoveryCache } from '@agent/core/local-stt-discovery';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const DEFAULT_TOOLS = ['herdr', 'imagesnap', 'blackhole-2ch'] as const;

type SetupStatus = 'ready' | 'needs_install' | 'unsupported';

interface SetupRow {
  tool_id: string;
  display_name: string;
  status: SetupStatus;
  selected_action: string;
  installed: boolean;
  requires_install: boolean;
  command?: string;
  detail: string;
}

function parseToolIds(raw: unknown, toolsCsv: unknown): string[] {
  if (typeof toolsCsv === 'string' && toolsCsv.trim()) {
    return toolsCsv
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [...DEFAULT_TOOLS];
}

export function resolveToolSelection(tool?: string, tools?: string, toolset?: string): string[] {
  if (toolset && (tool || tools)) {
    throw new ScriptExitError(1, 'Use --toolset or --tool/--tools, not both.');
  }
  const ids = toolset
    ? listToolRuntimes()
        .filter((record) => record.toolsets?.includes(toolset))
        .map((record) => record.tool_id)
    : parseToolIds(tool, tools);
  if (ids.length === 0)
    throw new ScriptExitError(1, `Unknown or empty toolset '${toolset}'. Use --list.`);
  const known = new Set(listToolRuntimes().map((record) => record.tool_id));
  for (const id of ids) {
    if (!known.has(id))
      throw new ScriptExitError(1, `Unknown tool_id '${id}'. Use --list to see registry entries.`);
  }
  return [...new Set(ids)];
}

function isBinaryHealthy(toolId: string): boolean {
  const trial = probeToolRuntime(toolId, 'trial');
  if (trial.install_backend?.command === 'uv' && trial.install_backend.args[0] === 'tool') {
    const entry = trial.tool.installed_backend?.args.at(-1);
    if (!entry || entry.includes('/') || entry.includes('\\')) return false;
    const binary = path.join(
      trial.managed_env_path,
      'bin',
      process.platform === 'win32' ? `${entry}.exe` : entry
    );
    return (
      safeExistsSync(binary) &&
      safeExecResult(binary, ['--help'], {
        cwd: pathResolver.rootDir(),
        timeoutMs: 15_000,
        maxOutputMB: 1,
      }).status === 0
    );
  }
  const backend = trial.tool.healthcheck_backend || trial.trial_backend;
  if (!backend) return false;
  // Trial launchers may download packages or start generation. Inspection must
  // never run those recipes; only explicitly probe-shaped commands are safe.
  if (
    !trial.tool.healthcheck_backend &&
    (['uvx', 'npx'].includes(backend.command) ||
      !backend.args.some((arg) =>
        ['--version', '-version', '-v', 'version', '-h', '--help', '-c', 'list'].includes(arg)
      ))
  )
    return false;
  const managedPython =
    trial.tool.ecosystem === 'python' && backend.command === 'python3'
      ? resolveManagedToolPythonBin(toolId)
      : null;
  if (
    trial.tool.ecosystem === 'python' &&
    backend.command === 'python3' &&
    trial.install_backend?.command === 'uv' &&
    trial.install_backend.args[0] === 'pip' &&
    !managedPython
  )
    return false;
  const command = findInstalledManagedBinary(toolId) ?? managedPython ?? backend.command;
  const result = safeExecResult(command, backend.args || [], {
    cwd: pathResolver.rootDir(),
    timeoutMs: 15_000,
    maxOutputMB: 2,
  });
  return result.status === 0;
}

function isCommandAvailable(command: string): boolean {
  const resolver = process.platform === 'win32' ? 'where.exe' : 'which';
  return (
    safeExecResult(resolver, [command], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 5_000,
      maxOutputMB: 1,
    }).status === 0
  );
}

export function inspectTool(toolId: string): SetupRow {
  const resolution = probeToolRuntime(toolId, 'installed');
  if (!supportsHost(toolId)) return unsupportedHost(toolId);
  const healthy = isBinaryHealthy(toolId);
  if (healthy) {
    return {
      tool_id: toolId,
      display_name: resolution.tool.display_name,
      status: 'ready',
      selected_action: resolution.selected_action,
      installed: true,
      requires_install: false,
      command: findInstalledManagedBinary(toolId) ?? resolution.trial_backend.command,
      detail: `${resolution.tool.display_name} is available (${resolution.reason}).`,
    };
  }
  if (!resolution.install_backend || !isCommandAvailable(resolution.install_backend.command)) {
    return {
      tool_id: toolId,
      display_name: resolution.tool.display_name,
      status: 'unsupported',
      selected_action: resolution.selected_action,
      installed: false,
      requires_install: true,
      detail: resolution.install_backend
        ? `Install command '${resolution.install_backend.command}' is unavailable on ${process.platform}.`
        : `No install backend registered for ${toolId} on ${process.platform}.`,
    };
  }
  return {
    tool_id: toolId,
    display_name: resolution.tool.display_name,
    status: 'needs_install',
    selected_action: resolution.selected_action,
    installed: false,
    requires_install: true,
    command:
      `${resolution.install_backend.command} ${(resolution.install_backend.args || []).join(' ')}`.trim(),
    detail: resolution.install_backend.description || resolution.reason,
  };
}

/**
 * A managed_binary pin must be a real sha256. The all-zero placeholder (or any
 * malformed digest) fails closed here, before any network access.
 */
export function assertPinnedSha256(toolId: string, version: string, sha256: unknown): string {
  const digest = typeof sha256 === 'string' ? sha256.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(digest) || /^0+$/.test(digest)) {
    throw new Error(
      `managed_binary sha256 for ${toolId} ${version} is not pinned (placeholder or malformed); fill in the upstream SHA2-256SUMS digest before installing`
    );
  }
  return digest;
}

/**
 * Validate raw `tar -tzf` output and return the normalized entry names.
 * Exported for tests; rejects absolute paths, drive-letter prefixes and `..`
 * components before the archive is ever extracted.
 */
export function validateManagedBinaryArchiveEntries(
  toolId: string,
  listingStdout: string
): string[] {
  const entries = listingStdout
    .split('\n')
    .map((entry) => entry.trim().replace(/^\.\//, ''))
    .filter(Boolean);
  if (!entries.length) {
    throw new Error(`managed_binary archive for ${toolId} is empty`);
  }
  for (const entry of entries) {
    if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry) || entry.split('/').includes('..')) {
      throw new Error(
        `managed_binary archive for ${toolId} contains an unsafe entry path: ${entry}`
      );
    }
  }
  return entries;
}

/**
 * Extract a checksum-verified `tar.gz` managed_binary payload into `destDir`.
 * Every archive entry is listed first and validated as a safe relative path;
 * only then is the archive extracted via the system tar — never through a shell.
 */
function extractManagedBinaryTarball(toolId: string, tarballPath: string, destDir: string): void {
  const listing = safeExecResult('tar', ['-tzf', tarballPath], {
    timeoutMs: 60_000,
    maxOutputMB: 4,
  });
  if (listing.status !== 0) {
    throw new Error(`managed_binary archive listing failed for ${toolId}: ${listing.stderr}`);
  }
  const entries = validateManagedBinaryArchiveEntries(toolId, listing.stdout);
  safeMkdir(destDir, { recursive: true });
  const extract = safeExecResult('tar', ['-xzf', tarballPath, '-C', destDir], {
    timeoutMs: 120_000,
    maxOutputMB: 4,
  });
  if (extract.status !== 0) {
    throw new Error(`managed_binary archive extraction failed for ${toolId}: ${extract.stderr}`);
  }
  for (const entry of entries) {
    const extracted = path.join(destDir, entry);
    try {
      if (safeExistsSync(extracted)) safeChmodSync(extracted, 0o755);
    } catch {
      // chmod is best-effort on non-executable entries (e.g. directories).
    }
  }
}

/**
 * Extract a checksum-verified zip managed_binary payload into `destDir`.
 * Lists entries first (unzip -l / PowerShell) and rejects unsafe paths before extract.
 */
function extractManagedBinaryZip(toolId: string, zipPath: string, destDir: string): void {
  safeMkdir(destDir, { recursive: true });
  if (process.platform === 'win32') {
    const listing = safeExecResult(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}').Entries | ForEach-Object { $_.FullName }`,
      ],
      { timeoutMs: 60_000, maxOutputMB: 4 }
    );
    if (listing.status !== 0) {
      throw new Error(`managed_binary zip listing failed for ${toolId}: ${listing.stderr}`);
    }
    const entries = validateManagedBinaryArchiveEntries(toolId, listing.stdout);
    const extract = safeExecResult(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ],
      { timeoutMs: 120_000, maxOutputMB: 4 }
    );
    if (extract.status !== 0) {
      throw new Error(`managed_binary zip extraction failed for ${toolId}: ${extract.stderr}`);
    }
    for (const entry of entries) {
      const extracted = path.join(destDir, entry);
      try {
        if (safeExistsSync(extracted)) safeChmodSync(extracted, 0o755);
      } catch {
        // best-effort
      }
    }
    return;
  }

  const listing = safeExecResult('unzip', ['-Z1', zipPath], {
    timeoutMs: 60_000,
    maxOutputMB: 4,
  });
  if (listing.status !== 0) {
    throw new Error(`managed_binary zip listing failed for ${toolId}: ${listing.stderr}`);
  }
  const entries = validateManagedBinaryArchiveEntries(toolId, listing.stdout);
  const extract = safeExecResult('unzip', ['-o', zipPath, '-d', destDir], {
    timeoutMs: 120_000,
    maxOutputMB: 4,
  });
  if (extract.status !== 0) {
    throw new Error(`managed_binary zip extraction failed for ${toolId}: ${extract.stderr}`);
  }
  for (const entry of entries) {
    const extracted = path.join(destDir, entry);
    try {
      if (safeExistsSync(extracted)) safeChmodSync(extracted, 0o755);
    } catch {
      // best-effort
    }
  }
}

export async function installManagedBinary(toolId: string): Promise<SetupRow | null> {
  const artifact = resolveManagedBinaryArtifact(toolId);
  const target = resolveManagedBinaryPath(toolId);
  if (!artifact || !target) return null;
  const record = getToolRuntimeRecord(toolId);
  const version = record.managed_binary?.version ?? 'unknown';
  if (isBinaryHealthy(toolId) && findInstalledManagedBinary(toolId)) {
    return {
      tool_id: toolId,
      display_name: record.display_name,
      status: 'ready',
      selected_action: 'run_installed',
      installed: true,
      requires_install: false,
      command: target,
      detail: `${record.display_name} ${version} is already in the managed env.`,
    };
  }

  // An unpinned (placeholder) digest never downloads; defer to the
  // package-manager install_backend instead of failing the whole setup.
  let expectedSha256: string;
  try {
    expectedSha256 = assertPinnedSha256(toolId, version, artifact.sha256);
  } catch (error) {
    logger.warn(
      `[tool-runtime-setup] skipping managed_binary for ${toolId}: ${error instanceof Error ? error.message : String(error)}; falling back to the install_backend`
    );
    return null;
  }
  const payload = await secureFetch<ArrayBuffer>({
    url: artifact.url,
    method: 'GET',
    responseType: 'arraybuffer',
    timeout: 600_000,
  });
  const data = Buffer.from(payload);
  const digest = createHash('sha256').update(data).digest('hex');
  if (digest !== expectedSha256) {
    throw new Error(
      `managed_binary checksum mismatch for ${toolId} ${version}: expected ${expectedSha256}, got ${digest}`
    );
  }
  const staging = `${target}.download`;
  safeWriteFile(staging, data);
  if (record.managed_binary?.archive === 'tar.gz') {
    extractManagedBinaryTarball(toolId, staging, path.dirname(target));
    safeUnlinkSync(staging);
  } else if (record.managed_binary?.archive === 'zip') {
    extractManagedBinaryZip(toolId, staging, path.dirname(target));
    safeUnlinkSync(staging);
  } else {
    safeChmodSync(staging, 0o755);
    safeMoveSync(staging, target);
  }

  const healthy = isBinaryHealthy(toolId);
  if (healthy)
    markToolRuntimeInstalled(toolId, {
      action: 'tool_runtime_setup',
      command: target,
      args: [],
      notes: `managed_binary ${version} sha256:${digest} from ${artifact.url}`,
    });
  return {
    tool_id: toolId,
    display_name: record.display_name,
    status: healthy ? 'ready' : 'needs_install',
    selected_action: 'run_installed',
    installed: healthy,
    requires_install: !healthy,
    command: target,
    detail: healthy
      ? `Installed ${record.display_name} ${version} into the managed env (sha256 verified).`
      : `Downloaded ${record.display_name} ${version} but the trial probe fails for ${target}.`,
  };
}

function supportsHost(toolId: string): boolean {
  const { platforms, status } = getToolRuntimeRecord(toolId);
  return (
    status !== 'disabled' &&
    platforms.some((platform) => platform === 'any' || platform === process.platform)
  );
}

function unsupportedHost(toolId: string): SetupRow {
  return {
    tool_id: toolId,
    display_name: getToolRuntimeRecord(toolId).display_name,
    status: 'unsupported',
    selected_action: 'install',
    installed: false,
    requires_install: true,
    detail: `${toolId} is disabled or unsupported on ${process.platform}.`,
  };
}

export function installTool(toolId: string): SetupRow {
  if (!supportsHost(toolId)) return unsupportedHost(toolId);
  const resolution = probeToolRuntime(toolId, 'approved_install');
  const backend = resolution.install_backend;
  if (isBinaryHealthy(toolId)) {
    markToolRuntimeInstalled(toolId, {
      action: 'tool_runtime_setup',
      notes: 'Existing runtime passed healthcheck.',
    });
    return {
      tool_id: toolId,
      display_name: resolution.tool.display_name,
      status: 'ready',
      selected_action: 'run_installed',
      installed: true,
      requires_install: false,
      detail: `${resolution.tool.display_name} is already available.`,
    };
  }
  if (!backend) {
    return {
      tool_id: toolId,
      display_name: resolution.tool.display_name,
      status: 'unsupported',
      selected_action: 'install',
      installed: false,
      requires_install: true,
      detail: `No install backend registered for ${toolId}.`,
    };
  }

  if (!isCommandAvailable(backend.command)) {
    return {
      tool_id: toolId,
      display_name: resolution.tool.display_name,
      status: 'unsupported',
      selected_action: 'install',
      installed: false,
      requires_install: true,
      command: `${backend.command} ${(backend.args || []).join(' ')}`.trim(),
      detail: `Install command '${backend.command}' is unavailable on ${process.platform}.`,
    };
  }

  let installArgs = backend.args;
  if (
    resolution.tool.ecosystem === 'python' &&
    backend.command === 'uv' &&
    backend.args[0] === 'pip' &&
    backend.args[1] === 'install'
  ) {
    const pythonBin = path.join(
      resolution.managed_env_path,
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    );
    const created = resolveManagedToolPythonBin(toolId)
      ? null
      : safeExecResult(
          'uv',
          [
            'venv',
            '--python',
            getRegisteredEnvText('KYBERION_MANAGED_PYTHON_VERSION')?.trim() || '3.11',
            resolution.managed_env_path,
          ],
          {
            cwd: pathResolver.rootDir(),
            timeoutMs: 120_000,
            maxOutputMB: 8,
          }
        );
    if (created && created.status !== 0)
      throw new Error(`Managed Python creation failed for ${toolId}: ${created.stderr}`);
    installArgs = ['pip', 'install', '--python', pythonBin, ...backend.args.slice(2)];
  }
  const toolEnv =
    backend.command === 'uv' && backend.args[0] === 'tool'
      ? {
          UV_TOOL_DIR: path.join(resolution.managed_env_path, 'tools'),
          UV_TOOL_BIN_DIR: path.join(resolution.managed_env_path, 'bin'),
        }
      : undefined;
  const result = safeExecResult(backend.command, installArgs, {
    cwd: pathResolver.rootDir(),
    ...(toolEnv ? { env: toolEnv } : {}),
    timeoutMs: 600_000,
    maxOutputMB: 32,
  });
  if (result.status !== 0) {
    throw new Error(
      `${backend.command} ${(backend.args || []).join(' ')} failed for ${toolId}: ${
        result.stderr || result.error?.message || 'unknown error'
      }`
    );
  }

  const healthy = isBinaryHealthy(toolId);
  if (healthy)
    markToolRuntimeInstalled(toolId, {
      action: 'tool_runtime_setup',
      command: backend.command,
      args: installArgs,
      notes: backend.description,
    });

  return {
    tool_id: toolId,
    display_name: resolution.tool.display_name,
    status: healthy ? 'ready' : 'needs_install',
    selected_action: 'run_installed',
    installed: healthy,
    requires_install: !healthy,
    command: `${backend.command} ${(backend.args || []).join(' ')}`.trim(),
    detail: healthy
      ? `Installed ${resolution.tool.display_name} via tool-runtime.`
      : `Install command succeeded but trial probe still fails for ${toolId} (reboot may be required for drivers).`,
  };
}

function scriptUserArgs(argv: readonly string[]): string[] {
  const cleaned = [...argv];
  // Drop non-flag noise left by `node --import … script.ts` and pnpm's `--` separator.
  while (cleaned.length > 0 && !cleaned[0]!.startsWith('-')) cleaned.shift();
  if (cleaned[0] === '--') cleaned.shift();
  return cleaned;
}

export const runToolRuntimeSetup = defineScript({
  name: 'tool-runtime-setup',
  flags: [],
  async run(context) {
    const argv = createStandardYargs([
      'node',
      'tool_runtime_setup',
      ...scriptUserArgs(context.argv),
    ])
      .option('tool', {
        type: 'string',
        describe: 'Single tool_id from the tool-runtime registry',
      })
      .option('tools', {
        type: 'string',
        describe: 'Comma-separated tool_ids (default: herdr,imagesnap,blackhole-2ch)',
      })
      .option('apply', {
        type: 'boolean',
        default: false,
        describe: 'Run the install backend (otherwise inspect only)',
      })
      .option('toolset', {
        type: 'string',
        describe: 'Select a registered runtime dependency group (see --list)',
      })
      .option('list', {
        type: 'boolean',
        default: false,
        describe: 'List all registered tool-runtime ids and exit',
      })
      .parseSync();

    if (argv.list) {
      const tools = listToolRuntimes().map((tool) => ({
        tool_id: tool.tool_id,
        display_name: tool.display_name,
        ecosystem: tool.ecosystem,
        status: tool.status,
        platforms: tool.platforms,
        toolsets: tool.toolsets || [],
      }));
      context.print(JSON.stringify({ tools }, null, 2));
      return;
    }

    const toolIds = resolveToolSelection(argv.tool, argv.tools, argv.toolset);

    const rows: SetupRow[] = [];
    for (const toolId of toolIds) {
      if (!argv.apply) {
        rows.push(inspectTool(toolId));
        continue;
      }
      try {
        if (!supportsHost(toolId)) {
          rows.push(unsupportedHost(toolId));
          continue;
        }
        rows.push((await installManagedBinary(toolId)) ?? installTool(toolId));
      } finally {
        // A just-installed runtime may be a local STT backend: drop the cached probe.
        resetLocalSttDiscoveryCache({ disk: true });
      }
    }

    const report = {
      apply: Boolean(argv.apply),
      platform: process.platform,
      rows,
      needs_install: rows.filter((row) => row.status === 'needs_install').map((row) => row.tool_id),
      unsupported: rows.filter((row) => row.status === 'unsupported').map((row) => row.tool_id),
      ready: rows.filter((row) => row.status === 'ready').map((row) => row.tool_id),
    };
    context.print(JSON.stringify(report, null, 2));

    if (!argv.apply && (report.needs_install.length > 0 || report.unsupported.length > 0)) {
      throw new ScriptExitError(
        2,
        `Tools unavailable: ${[...report.needs_install, ...report.unsupported].join(', ')}.`
      );
    }
    if (argv.apply && rows.some((row) => row.status !== 'ready')) {
      throw new ScriptExitError(1, 'One or more tools remain unavailable after install.');
    }
  },
});

if (
  isDirectScript(import.meta.url, 'tool_runtime_setup.ts') ||
  isDirectScript(import.meta.url, 'tool_runtime_setup.js')
)
  void runToolRuntimeSetup();
