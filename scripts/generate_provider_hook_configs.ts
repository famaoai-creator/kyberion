/**
 * generate_provider_hook_configs.ts — generation ceremony for provider CLI
 * hook wiring that cannot be committed (provider state dirs are gitignored
 * per the multi-provider co-execution contract).
 *
 * Owns Gemini event groups in `.gemini/settings.json`: SessionStart /
 * BeforeAgent / BeforeTool / SessionEnd are wired to
 * dist/scripts/gemini_cli_hook.js so Gemini CLI sessions join the checkout's
 * co-session, receive pending handoffs on each prompt, and get denied when
 * writing paths leased by another participant.
 *
 * Merge semantics: unknown top-level keys and non-owned hook event names in an
 * existing `.gemini/settings.json` are preserved; the four owned event groups
 * are ceremony-owned and replaced wholesale.
 *
 * Usage:
 * Codex wiring lives in `.codex/hooks.json`: SessionStart / UserPromptSubmit /
 * PostToolUse / SessionEnd. Preserve user commands within the same events and
 * never register Stop. Hook trust remains a native CLI /hooks decision.
 *
 *   pnpm generate:provider-hooks           — write Gemini + Codex hooks
 *   pnpm generate:provider-hooks -- --check — fail if the file drifted
 */

import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { readTextFile } from '@agent/core/foundation';
import { parseSafeJsonInput } from '@agent/core/foundation/safe-json';
import { isRecord } from '@agent/core/foundation/text';
import { defineGenerator, isDirectScript } from './lib/harness.js';

const GEMINI_SETTINGS = '.gemini/settings.json';
const CODEX_HOOKS = '.codex/hooks.json';
const OWNED_EVENTS = ['SessionStart', 'BeforeAgent', 'BeforeTool', 'SessionEnd'] as const;

function hookCommand(event: string): string {
  const script = path.join(pathResolver.rootDir(), 'dist', 'scripts', 'gemini_cli_hook.js');
  return `node "${script}" ${event}`;
}

interface GeminiHookGroup {
  matcher?: string;
  sequential?: boolean;
  hooks: Array<{ type: string; name?: string; command: string; timeout?: number }>;
}

function hookGroup(command: string, matcher?: string): GeminiHookGroup {
  return {
    ...(matcher ? { matcher } : {}),
    sequential: true,
    hooks: [{ type: 'command', name: 'kyberion-co-session', command, timeout: 10000 }],
  };
}

function buildManagedHooks(): Record<string, GeminiHookGroup[]> {
  return {
    SessionStart: [hookGroup(hookCommand('SessionStart'))],
    BeforeAgent: [hookGroup(hookCommand('BeforeAgent'))],
    BeforeTool: [hookGroup(hookCommand('BeforeTool'), 'write_file|replace')],
    SessionEnd: [hookGroup(hookCommand('SessionEnd'))],
  };
}

function loadExistingSettings(relativePath = GEMINI_SETTINGS): Record<string, unknown> {
  const filePath = pathResolver.rootResolve(relativePath);
  if (!safeExistsSync(filePath)) return {};
  const parsed = parseSafeJsonInput(readTextFile(filePath), relativePath);
  if (!isRecord(parsed))
    throw new Error(`${relativePath} must contain an object; refusing to replace it`);
  return parsed;
}

/** Preserve user hooks even in owned event groups. Only our command is replaced. */
export function buildCodexHooks(existing: Record<string, unknown> = {}): Record<string, unknown> {
  if ('hooks' in existing && !isRecord(existing.hooks)) {
    throw new Error('Codex hooks must be an object; refusing to replace existing configuration');
  }
  const hooks = isRecord(existing.hooks) ? { ...existing.hooks } : {};
  const script = path.join(pathResolver.rootDir(), 'dist', 'scripts', 'codex_cli_hook.js');
  // Quote for the command shell, including checkout paths containing $ or `.
  const quoted = `'${script.replaceAll("'", "'\\''")}'`;
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'SessionEnd']) {
    if (event in hooks && !Array.isArray(hooks[event])) {
      throw new Error(`Codex ${event} hooks must be an array; refusing to replace them`);
    }
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const preserved = groups.flatMap((group: unknown) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
      const remaining = group.hooks.filter(
        (hook: unknown) =>
          !(
            isRecord(hook) &&
            typeof hook.command === 'string' &&
            /(?:^|[\\/])codex_cli_hook\.js["']?\s/.test(hook.command)
          )
      );
      return remaining.length ? [{ ...group, hooks: remaining }] : [];
    });
    hooks[event] = [
      ...preserved,
      {
        hooks: [
          {
            type: 'command',
            command: `node ${quoted} ${event}`,
            timeout: event === 'SessionEnd' ? 3 : 10,
          },
        ],
      },
    ];
  }
  return { ...existing, hooks };
}

export function buildGeminiSettings(
  existing: Record<string, unknown> = {}
): Record<string, unknown> {
  const existingHooks = isRecord(existing.hooks) ? existing.hooks : {};
  const preserved: Record<string, unknown> = {};
  for (const [name, groups] of Object.entries(existingHooks)) {
    if (!(OWNED_EVENTS as readonly string[]).includes(name)) preserved[name] = groups;
  }
  return {
    ...existing,
    hooks: { ...preserved, ...buildManagedHooks() },
  };
}

export const runGenerateProviderHookConfigs = defineGenerator({
  id: 'provider-hook-configs',
  outputs: [GEMINI_SETTINGS, CODEX_HOOKS],
  executionContext: 'generate_provider_hook_configs',
  render: async () => {
    const hookJs = path.join(pathResolver.rootDir(), 'dist', 'scripts', 'gemini_cli_hook.js');
    if (!safeExistsSync(hookJs)) {
      process.stderr.write(
        '[generate:provider-hooks] warning: dist/scripts/gemini_cli_hook.js does not exist yet — ' +
          'hook commands target dist/; run `pnpm run build` before relying on the wiring.\n'
      );
    }
    const merged = buildGeminiSettings(loadExistingSettings());
    const codex = buildCodexHooks(loadExistingSettings(CODEX_HOOKS));
    return [
      { path: GEMINI_SETTINGS, content: `${JSON.stringify(merged, null, 2)}\n` },
      { path: CODEX_HOOKS, content: `${JSON.stringify(codex, null, 2)}\n` },
    ];
  },
});

if (
  isDirectScript(import.meta.url, 'generate_provider_hook_configs.ts') ||
  isDirectScript(import.meta.url, 'generate_provider_hook_configs.js')
) {
  void runGenerateProviderHookConfigs();
}
