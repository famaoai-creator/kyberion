#!/usr/bin/env node
/**
 * Governed install/inspect surface for system tool-runtime entries
 * (Herdr, ImageSnap, BlackHole, …).
 *
 *   pnpm tool:setup -- --tool herdr
 *   pnpm tool:setup -- --tool herdr --apply
 *   pnpm tool:setup -- --tools herdr,imagesnap,blackhole-2ch --apply
 *   pnpm tool:setup -- --list
 */

import { createStandardYargs } from '@agent/core/cli-utils';
import {
  listToolRuntimes,
  markToolRuntimeInstalled,
  probeToolRuntime,
} from '@agent/core/tool-runtime-registry';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult } from '@agent/core/secure-io';
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

function isBinaryHealthy(toolId: string): boolean {
  const trial = probeToolRuntime(toolId, 'trial');
  const backend = trial.trial_backend;
  if (!backend) return false;
  const result = safeExecResult(backend.command, backend.args || [], {
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

function inspectTool(toolId: string): SetupRow {
  const resolution = probeToolRuntime(toolId, 'installed');
  const healthy = isBinaryHealthy(toolId);
  if (healthy) {
    return {
      tool_id: toolId,
      display_name: resolution.tool.display_name,
      status: 'ready',
      selected_action: resolution.selected_action,
      installed: true,
      requires_install: false,
      command: resolution.trial_backend.command,
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

function installTool(toolId: string): SetupRow {
  const resolution = probeToolRuntime(toolId, 'approved_install');
  const backend = resolution.install_backend;
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

  if (isBinaryHealthy(toolId)) {
    markToolRuntimeInstalled(toolId, {
      action: 'tool_runtime_setup',
      command: backend.command,
      args: backend.args,
      notes: 'Already present on PATH; marked installed.',
    });
    return {
      tool_id: toolId,
      display_name: resolution.tool.display_name,
      status: 'ready',
      selected_action: 'run_installed',
      installed: true,
      requires_install: false,
      command: backend.command,
      detail: `${resolution.tool.display_name} was already available; marked installed.`,
    };
  }

  const result = safeExecResult(backend.command, backend.args || [], {
    cwd: pathResolver.rootDir(),
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

  markToolRuntimeInstalled(toolId, {
    action: 'tool_runtime_setup',
    command: backend.command,
    args: backend.args,
    notes: backend.description,
  });

  const healthy = isBinaryHealthy(toolId);
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
  run(context) {
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
      }));
      context.print(JSON.stringify({ tools }, null, 2));
      return;
    }

    const toolIds = parseToolIds(argv.tool, argv.tools);
    const known = new Set(listToolRuntimes().map((tool) => tool.tool_id));
    for (const toolId of toolIds) {
      if (!known.has(toolId)) {
        throw new ScriptExitError(
          1,
          `Unknown tool_id '${toolId}'. Use --list to see registry entries.`
        );
      }
    }

    const rows: SetupRow[] = [];
    for (const toolId of toolIds) {
      rows.push(argv.apply ? installTool(toolId) : inspectTool(toolId));
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
