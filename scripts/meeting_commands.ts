/**
 * Interactive mid-meeting verbs for `meeting:participate`.
 *
 * While the coordinator owns the session loop, the operator (or a parent
 * agent piping stdin) can type declared gestures: raise-hand, admit,
 * chat, status, leave. Parsing is pure and unit-tested; execution only
 * touches the optional session verbs so non-extension drivers degrade
 * to a clear "unsupported" message instead of failing.
 */

import type { MeetingSession } from '@agent/core/meeting-session-types';
import * as readline from 'node:readline';

export type MeetingCommand =
  | { verb: 'help' }
  | { verb: 'status' }
  | { verb: 'raise-hand' }
  | { verb: 'admit'; name?: string }
  | { verb: 'chat'; text: string }
  | { verb: 'leave' }
  | { verb: 'unknown'; raw: string };

/** Parse one input line. Returns null for blank lines. */
export function parseMeetingCommand(line: string): MeetingCommand | null {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  const [head, ...rest] = trimmed.split(/\s+/);
  const verb = head.toLowerCase();
  if (verb === 'help' || verb === '?') return { verb: 'help' };
  if (verb === 'status') return { verb: 'status' };
  if (verb === 'raise-hand' || verb === 'raise_hand' || verb === 'raisehand') {
    return { verb: 'raise-hand' };
  }
  if (verb === 'admit') {
    const name = rest.join(' ').trim();
    return name ? { verb: 'admit', name } : { verb: 'admit' };
  }
  if (verb === 'chat') {
    const text = rest.join(' ').trim();
    return text ? { verb: 'chat', text } : { verb: 'unknown', raw: trimmed };
  }
  if (verb === 'leave' || verb === 'quit' || verb === 'exit') return { verb: 'leave' };
  return { verb: 'unknown', raw: trimmed };
}

export const MEETING_COMMAND_HELP = [
  'meeting commands: status | raise-hand | admit [name] | chat <text> | leave | help',
].join('\n');

export interface MeetingCommandContext {
  getSession: () => MeetingSession | null;
  /** Admit exercises host authority — must be explicitly allowed per run. */
  allowAdmit: boolean;
  onOutput: (message: string) => void;
  onTrace: (event: string, detail?: Record<string, unknown>) => void;
}

/** Execute one parsed command. Returns true when the loop should end. */
export async function runMeetingCommand(
  session: MeetingSession | null,
  command: MeetingCommand,
  context: MeetingCommandContext
): Promise<boolean> {
  const { onOutput, onTrace } = context;
  switch (command.verb) {
    case 'help':
      onOutput(MEETING_COMMAND_HELP);
      return false;
    case 'status': {
      if (!session) {
        onOutput('not joined yet');
        return false;
      }
      onOutput(
        `session=${session.state.session_id} platform=${session.state.platform} status=${session.state.status}`
      );
      return false;
    }
    case 'raise-hand': {
      if (!session) {
        onOutput('not joined yet');
        return false;
      }
      if (typeof session.raiseHand !== 'function') {
        onOutput('raise-hand is not supported by this driver');
        return false;
      }
      try {
        const result = await session.raiseHand();
        onOutput(result.already ? 'hand already raised' : 'hand raised');
        onTrace('meeting_participation.raise_hand', { already: result.already });
      } catch (err) {
        onOutput(`raise-hand failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return false;
    }
    case 'admit': {
      if (!context.allowAdmit) {
        onOutput('admit is refused: re-run with --allow-admit to grant host authority');
        onTrace('meeting_participation.admit_refused', {});
        return false;
      }
      if (!session) {
        onOutput('not joined yet');
        return false;
      }
      if (typeof session.admit !== 'function') {
        onOutput('admit is not supported by this driver');
        return false;
      }
      try {
        const result = await session.admit(command.name);
        onOutput(`admitted ${result.admitted}${command.name ? ` (filter: ${command.name})` : ''}`);
        onTrace('meeting_participation.admit', {
          admitted: result.admitted,
          ...(command.name ? { name: command.name } : {}),
        });
      } catch (err) {
        onOutput(`admit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return false;
    }
    case 'chat': {
      if (!session) {
        onOutput('not joined yet');
        return false;
      }
      try {
        await session.chat(command.text);
        onOutput('chat sent');
        onTrace('meeting_participation.chat', { chars: command.text.length });
      } catch (err) {
        onOutput(`chat failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return false;
    }
    case 'leave': {
      if (session) {
        try {
          await session.leave();
        } catch {
          /* coordinator finally-block also leaves; best effort here */
        }
      }
      onOutput('leaving');
      onTrace('meeting_participation.operator_leave', {});
      return true;
    }
    case 'unknown':
      onOutput(`unknown command: ${command.raw} (try: help)`);
      return false;
  }
}

export interface MeetingCommandLoop {
  /** Resolve when the loop ends (leave typed, stdin closed, or stopped). */
  done: Promise<void>;
  stop: () => void;
}

/**
 * Read commands from `input` until `leave`, EOF, or `stop()`.
 * Call `stop()` when the participation run ends so the process can exit.
 */
export function startMeetingCommandLoop(options: {
  context: MeetingCommandContext;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  prompt?: string;
}): MeetingCommandLoop {
  const { context } = options;
  const rl = readline.createInterface({
    input: options.input ?? process.stdin,
    output: options.output,
    prompt: options.prompt ?? 'meeting> ',
  });
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    try {
      rl.close();
    } catch {
      /* noop */
    }
    resolveDone();
  };
  rl.on('line', (line) => {
    void (async () => {
      const command = parseMeetingCommand(line);
      if (!command) {
        rl.prompt();
        return;
      }
      const end = await runMeetingCommand(context.getSession(), command, context);
      if (end) {
        finish();
        return;
      }
      rl.prompt();
    })();
  });
  rl.on('close', finish);
  rl.prompt();
  return { done, stop: finish };
}
