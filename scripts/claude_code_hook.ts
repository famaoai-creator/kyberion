/**
 * Kyberion ↔ Claude Code hook entry point.
 *
 * Invoked by the kyberion-claude-code plugin's hooks. Reads the hook event JSON
 * from stdin and the event name from argv[2], dispatches to the governed
 * handlers in `@agent/core/claude-code-hook`, and writes the hook response
 * JSON to stdout.
 *
 *   node dist/scripts/claude_code_hook.js SessionStart  < event.json
 *   node dist/scripts/claude_code_hook.js UserPromptSubmit < event.json
 *   node dist/scripts/claude_code_hook.js PreToolUse     < event.json
 *   node dist/scripts/claude_code_hook.js PostToolUse    < event.json
 *   node dist/scripts/claude_code_hook.js Stop           < event.json
 *
 * Never blocks Claude Code on an internal error: on failure it exits 0 and (for
 * PreToolUse) fails open with an explanatory reason.
 */

import {
  buildSessionStartContext,
  buildStopContext,
  buildUserPromptSubmitContext,
  evaluatePreToolUse,
  recordCliUsage,
  recordPostToolUse,
  summarizeTranscriptUsage,
} from '@agent/core/claude-code-hook';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { parseSafeJsonInput } from '@agent/core/foundation';
import { isRecord } from '@agent/core/foundation/text';
import { currentProcessArgv, defineScript, isDirectScript } from './lib/harness.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

export function parseHookPayload(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = parseSafeJsonInput(raw, 'Claude Code hook payload');
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function main(args: string[] = currentProcessArgv()): Promise<void> {
  const event = args[2] ?? '';
  const raw = await readStdin();
  const payload = parseHookPayload(raw);

  switch (event) {
    case 'SessionStart': {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: buildSessionStartContext(),
          },
        })
      );
      return;
    }
    case 'UserPromptSubmit': {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: buildUserPromptSubmitContext(payload),
          },
        })
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
    case 'Stop': {
      // Capture this CLI session's token usage into metrics (best-effort).
      try {
        const transcriptPath =
          typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
        if (transcriptPath && safeExistsSync(transcriptPath)) {
          recordCliUsage(
            summarizeTranscriptUsage(safeReadFile(transcriptPath, { encoding: 'utf8' }) as string)
          );
        }
      } catch {
        // usage capture is best-effort; never block session close
      }
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'Stop',
            additionalContext: buildStopContext(payload),
          },
        })
      );
      return;
    }
    default:
      return;
  }
}

export const claudeCodeHook = defineScript({
  name: 'claude-code-hook',
  flags: [],
  run: async ({ argv }) => {
    const hookArgv = ['node', 'claude_code_hook', ...argv];
    try {
      await main(hookArgv);
    } catch (err) {
      // Fail open: emit an allow decision for PreToolUse so a hook bug never wedges the session.
      if (hookArgv[2] === 'PreToolUse') {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              permissionDecisionReason: `Kyberion hook errored (failing open): ${String(err)}`,
            },
          })
        );
      } else {
        process.stderr.write(`[claude_code_hook] ${String(err)}\n`);
      }
    }
  },
});

if (
  isDirectScript(import.meta.url, 'claude_code_hook.ts') ||
  isDirectScript(import.meta.url, 'claude_code_hook.js')
)
  void claudeCodeHook();
