/** Codex native hooks: pull coordination at safe boundaries, never resume Stop.
 * No model calls, automatic replies, acknowledgements, or shell execution. */
import {
  coSessionHookDrain,
  coSessionHookEnd,
  coSessionHookJoin,
  formatPendingHandoffs,
} from '@agent/core/provider/co-session-hook';
import { isRecord } from '@agent/core/foundation/text';
import { parseSafeJsonInput } from '@agent/core/foundation/safe-json';
import { currentProcessArgv, defineScript, isDirectScript } from './lib/harness.js';

export function handleCodexHookEvent(
  event: string,
  payload: Record<string, unknown>
): string | undefined {
  const sessionKey = typeof payload.session_id === 'string' ? payload.session_id : undefined;
  if (!sessionKey?.trim()) return undefined;
  // Stop and unknown events are deliberately inert, including continued turns.
  if (!['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'SessionEnd'].includes(event))
    return undefined;
  try {
    if (event === 'SessionEnd') {
      coSessionHookEnd({ provider: 'codex', session_key: sessionKey });
      return undefined;
    }
    const lines: string[] = [];
    if (event === 'SessionStart') {
      const joined = coSessionHookJoin({ provider: 'codex', session_key: sessionKey });
      if (joined.joined)
        lines.push(
          `Kyberion co-session ${joined.session_id}: participant ${joined.participant_id}. ` +
            'Before editing shared paths, inspect co-session status and acquire a path lease with ' +
            `\`co-session lease --action acquire --as codex --participant-id ${joined.participant_id} --path <repo/path>\`. ` +
            'Codex leases are advisory; shell and patch writes are not fenced by this adapter. ' +
            'Coordinate conflicts, review requests, blockers, and handoffs explicitly; avoid automatic notification replies.'
        );
    }
    const block = formatPendingHandoffs(
      coSessionHookDrain({
        provider: 'codex',
        session_key: sessionKey,
        only_new: true,
      })
    );
    if (block) lines.push(block);
    return lines.length
      ? JSON.stringify({
          hookSpecificOutput: {
            hookEventName: event,
            additionalContext: lines.join('\n\n'),
          },
        })
      : undefined;
  } catch {
    // Coordination failure must not wedge the CLI. Leases expire by TTL.
    return undefined;
  }
}

export async function main(args: string[] = currentProcessArgv()): Promise<void> {
  if (process.stdin.isTTY) return;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  let payload: unknown;
  try {
    payload = parseSafeJsonInput(Buffer.concat(chunks).toString('utf8'), 'Codex hook payload');
  } catch {
    return;
  }
  if (!isRecord(payload)) return;
  const output = handleCodexHookEvent(args[2] ?? '', payload);
  if (output) process.stdout.write(output);
}

export const runCodexCliHook = defineScript({
  name: 'codex-cli-hook',
  run: async ({ argv }) => {
    await main(['node', 'codex_cli_hook', ...argv]);
  },
});

if (
  isDirectScript(import.meta.url, 'codex_cli_hook.ts') ||
  isDirectScript(import.meta.url, 'codex_cli_hook.js')
) {
  void runCodexCliHook();
}
