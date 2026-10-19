#!/usr/bin/env node
/** Stable hook bootstrap: build cleanup may remove dist/ between hook events.
 * Keep this dependency-free so policy failures can still return a native deny.
 *
 * When the built runtime is missing the hook stays fail-closed: every Claude
 * PreToolUse (Edit/Write) and shell event is denied — except a minimal set of
 * exact-shape bootstrap commands, so the agent can rebuild dist/ itself instead
 * of deadlocking (see docs/developer/CLOUD_AGENT_ENVIRONMENT.md).
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const PROVIDERS = {
  codex: ['codex_cli_hook.js', 'runCodexCliHook'],
  claude: ['claude_code_hook.js', 'claudeCodeHook'],
  gemini: ['gemini_cli_hook.js', 'runGeminiCliHook'],
};

const UNAVAILABLE = 'Kyberion hook runtime unavailable; wait for pnpm build to finish, then retry.';
const BOOTSTRAP_HINT =
  ' To bootstrap, run `pnpm install --prefer-offline`, then `pnpm build`, as separate Bash ' +
  'commands (cloud sessions: `bash .claude/hooks/session-start.sh`). Until dist/ exists only ' +
  'these exact bootstrap commands and read-only git status/log/fetch/switch are allowed.';

/** Largest hook payload we parse in the fallback path; anything bigger is denied. */
const MAX_PAYLOAD_BYTES = 64 * 1024;

// Plain words only: no quotes, globs, `$`, `;`, `&`, `|`, backticks, redirects,
// parentheses, backslashes or newlines can survive this, so nothing can be chained.
const SAFE_COMMAND = /^[A-Za-z0-9_@./=+-]+(?: [A-Za-z0-9_@./=+-]+)*$/;
// A git ref / remote name: never an option (leading `-`), never a refspec (`:`)
// or a path-like `.`/`..`.
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const isRef = (token) => GIT_REF.test(token) && !token.includes('..');

/** Every token may appear at most once and must come from `allowed`. */
function onlyFlags(tokens, allowed) {
  return new Set(tokens).size === tokens.length && tokens.every((t) => allowed.includes(t));
}

function isAllowedGit(args) {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'status':
      return onlyFlags(rest, ['-s', '--short', '-b', '--branch', '-sb', '--porcelain']);
    case 'log': {
      const flags = rest.filter((t) => t.startsWith('-'));
      const refs = rest.filter((t) => !t.startsWith('-'));
      return (
        refs.length <= 1 &&
        refs.every(isRef) &&
        new Set(flags).size === flags.length &&
        flags.every((t) => t === '--oneline' || /^-[1-9][0-9]{0,3}$/.test(t))
      );
    }
    case 'fetch': {
      const opts = rest[0] === '--prune' || rest[0] === '--quiet' ? rest.slice(1) : rest;
      return opts.length <= 2 && opts.every(isRef);
    }
    case 'switch':
      // `git switch <branch>` or `git switch -c <new> [<start>]`; switch never takes paths.
      if (rest[0] === '-c')
        return rest.length >= 2 && rest.length <= 3 && rest.slice(1).every(isRef);
      return rest.length === 1 && isRef(rest[0]);
    case 'checkout':
      // Only the branch-creating form: bare `git checkout <x>` can restore a file
      // over uncommitted work when <x> names a path, so it stays denied.
      return rest[0] === '-b' && rest.length >= 2 && rest.length <= 3 && rest.slice(1).every(isRef);
    default:
      return false;
  }
}

/**
 * True only for the exact-shape bootstrap commands that rebuild the runtime.
 * Exported for tests; keep this list minimal — it is a governance bypass.
 */
export function isBootstrapCommand(command) {
  if (typeof command !== 'string') return false;
  const normalized = command.trim().replace(/[ \t]+/g, ' ');
  if (!normalized || !SAFE_COMMAND.test(normalized)) return false;
  const [bin, ...args] = normalized.split(' ');
  if (bin === 'pnpm') {
    if (args[0] === 'install') {
      return onlyFlags(args.slice(1), ['--frozen-lockfile', '--prefer-offline']);
    }
    const shape = args.join(' ');
    return shape === 'build' || shape === '--filter @agent/core build';
  }
  if (bin === 'bash') return args.length === 1 && args[0] === '.claude/hooks/session-start.sh';
  if (bin === 'git') return isAllowedGit(args);
  return false;
}

/** Claude shell payload: `{ tool_name: 'Bash', tool_input: { command } }`. */
export function bootstrapCommandFromPayload(raw) {
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw) > MAX_PAYLOAD_BYTES) return null;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const tool = payload.tool_name;
  if (tool !== undefined && tool !== 'Bash' && tool !== 'exec') return null;
  const command = payload.tool_input?.command;
  return isBootstrapCommand(command) ? command.trim() : null;
}

async function readProcessStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_PAYLOAD_BYTES) return '';
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function runProviderHook(provider, event, options = {}) {
  const config = PROVIDERS[provider];
  if (!config || !event)
    throw new Error('Usage: provider_hook_entry.mjs <codex|claude|gemini> <event>');
  const load = options.load ?? ((url) => import(url));
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  const readInput = options.readInput ?? readProcessStdin;
  let run;
  try {
    const module = await load(new URL(`../dist/scripts/${config[0]}`, import.meta.url).href);
    run = module[config[1]];
    if (typeof run !== 'function') throw new Error('hook runner unavailable');
  } catch {
    const prefix = `[provider-hook:${provider}/${event}]`;
    if (provider === 'claude' && event === 'PreToolUseShellDeny') {
      // Only shell events read the payload: the allowlist never applies to Edit/Write.
      let raw = '';
      try {
        raw = await readInput();
      } catch {
        raw = '';
      }
      const command = bootstrapCommandFromPayload(raw);
      if (command) {
        // No decision: the normal permission flow applies to the bootstrap command.
        stderr(`${prefix} ${UNAVAILABLE} Allowing bootstrap command: ${command}\n`);
        return;
      }
    }
    stderr(`${prefix} ${UNAVAILABLE}\n`);
    if (provider === 'claude' && ['PreToolUse', 'PreToolUseShellDeny'].includes(event)) {
      stdout(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: UNAVAILABLE + BOOTSTRAP_HINT,
          },
        })
      );
    } else if (provider === 'gemini' && event === 'BeforeTool') {
      stdout(JSON.stringify({ decision: 'deny', reason: UNAVAILABLE + BOOTSTRAP_HINT }));
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
