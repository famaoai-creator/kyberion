#!/usr/bin/env node
/** Stable hook bootstrap: build cleanup may remove dist/ between hook events.
 * Keep this dependency-free so policy failures can still return a native deny.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const PROVIDERS = {
  codex: ['codex_cli_hook.js', 'runCodexCliHook'],
  claude: ['claude_code_hook.js', 'claudeCodeHook'],
  gemini: ['gemini_cli_hook.js', 'runGeminiCliHook'],
};

export async function runProviderHook(provider, event, options = {}) {
  const config = PROVIDERS[provider];
  if (!config || !event)
    throw new Error('Usage: provider_hook_entry.mjs <codex|claude|gemini> <event>');
  const load = options.load ?? ((url) => import(url));
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  let run;
  try {
    const module = await load(new URL(`../dist/scripts/${config[0]}`, import.meta.url).href);
    run = module[config[1]];
    if (typeof run !== 'function') throw new Error('hook runner unavailable');
  } catch {
    const reason = 'Kyberion hook runtime unavailable; wait for pnpm build to finish, then retry.';
    stderr(`[provider-hook:${provider}/${event}] ${reason}\n`);
    if (provider === 'claude' && ['PreToolUse', 'PreToolUseShellDeny'].includes(event)) {
      stdout(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        })
      );
    } else if (provider === 'gemini' && event === 'BeforeTool') {
      stdout(JSON.stringify({ decision: 'deny', reason }));
    }
    return;
  }
  // The established runner owns runtime failures and exit status. Do not append
  // bootstrap output after it has already written a native protocol response.
  await run([event]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runProviderHook(...process.argv.slice(2));
}
