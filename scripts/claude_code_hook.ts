/**
 * Kyberion ↔ Claude Code hook entry point.
 *
 * Invoked by the kyberion-claude-code plugin's hooks. Reads the hook event JSON
 * from stdin and the event name from argv[2], dispatches to the governed
 * handlers in `@agent/core/claude-code-hook.js`, and writes the hook response
 * JSON to stdout.
 *
 *   node dist/scripts/claude_code_hook.js SessionStart  < event.json
 *   node dist/scripts/claude_code_hook.js PreToolUse     < event.json
 *   node dist/scripts/claude_code_hook.js PostToolUse    < event.json
 *
 * Never blocks Claude Code on an internal error: on failure it exits 0 and (for
 * PreToolUse) fails open with an explanatory reason.
 */

import {
  buildSessionStartContext,
  evaluatePreToolUse,
  recordPostToolUse,
} from '@agent/core/claude-code-hook.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main(): Promise<void> {
  const event = process.argv[2] ?? '';
  const raw = await readStdin();
  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }

  switch (event) {
    case 'SessionStart': {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: buildSessionStartContext() },
        }),
      );
      return;
    }
    case 'PreToolUse': {
      process.stdout.write(JSON.stringify(evaluatePreToolUse(payload)));
      return;
    }
    case 'PostToolUse': {
      try {
        recordPostToolUse(payload);
      } catch {
        // audit is best-effort; never block the session
      }
      return;
    }
    default:
      return;
  }
}

main().catch((err) => {
  // Fail open: emit an allow decision for PreToolUse so a hook bug never wedges the session.
  if (process.argv[2] === 'PreToolUse') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `Kyberion hook errored (failing open): ${String(err)}`,
        },
      }),
    );
  } else {
    process.stderr.write(`[claude_code_hook] ${String(err)}\n`);
  }
  process.exit(0);
});
