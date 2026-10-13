/**
 * generate_provider_hook_configs.ts — generation ceremony for provider CLI
 * hook wiring that cannot be committed (provider state dirs are gitignored
 * per the multi-provider co-execution contract).
 *
 * Currently owns the `hooks` block of `.gemini/settings.json`: SessionStart /
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
 *   pnpm generate:provider-hooks           — write .gemini/settings.json
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

function loadExistingSettings(): Record<string, unknown> {
  const filePath = pathResolver.rootResolve(GEMINI_SETTINGS);
  if (!safeExistsSync(filePath)) return {};
  try {
    const parsed = parseSafeJsonInput(readTextFile(filePath), GEMINI_SETTINGS);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
  outputs: [GEMINI_SETTINGS],
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
    return [{ path: GEMINI_SETTINGS, content: `${JSON.stringify(merged, null, 2)}\n` }];
  },
});

if (
  isDirectScript(import.meta.url, 'generate_provider_hook_configs.ts') ||
  isDirectScript(import.meta.url, 'generate_provider_hook_configs.js')
) {
  void runGenerateProviderHookConfigs();
}
