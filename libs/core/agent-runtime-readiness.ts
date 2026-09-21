/**
 * Telling "ready" apart from "stopped and waiting for a human".
 *
 * A pane runtime reported `ensure_completed` four seconds after launch and
 * dispatch then waited ten minutes for a response that was never coming: the
 * agent inside the pane was sitting on
 *
 *     Do you trust the contents of this project?
 *     > Yes, I trust this folder
 *       No, exit
 *
 * The process existed, so "ensured" was true, and the runtime had no way to
 * say the difference. From the outside an agent blocked on a first-run
 * prompt looks exactly like an idle one waiting for work — same process,
 * same pane, same `idle` status — and the only observable difference is what
 * is on its screen.
 *
 * So readiness is read from the screen, and the states are distinguished:
 *
 * - `awaiting_human` — a prompt is on screen and nothing will happen until
 *   somebody answers it. **Returned immediately**, with the prompt text,
 *   because waiting is precisely the wrong response: the timeout is the
 *   cost of not looking.
 * - `starting` — banners, spinners, "loading" and nothing else yet. Worth
 *   waiting for.
 * - `ready` — the agent is accepting work.
 * - `unavailable` — the pane is gone or cannot be read.
 *
 * The signatures below are deliberately broad. A prompt this misses costs a
 * timeout, which is what happens today; a false positive costs one early
 * return with the screen text attached, which a human can read and dismiss.
 * The asymmetry favours over-detection.
 */

import { createLogger } from './logger.js';

const logger = createLogger('agent-runtime-readiness');

export type AgentReadinessState = 'ready' | 'awaiting_human' | 'starting' | 'unavailable';

export interface AgentReadiness {
  state: AgentReadinessState;
  /** Deterministic explanation; safe to log and to show a person. */
  reason: string;
  /** The lines that matched, when a prompt was detected. */
  promptExcerpt?: string;
  /** Which signature matched, for telemetry and for tightening the list. */
  signatureId?: string;
}

interface PromptSignature {
  id: string;
  pattern: RegExp;
  /** One line a person can act on. */
  humanAction: string;
}

/**
 * What an agent stops for on a path it has not seen before. Every one of
 * these has been observed to hold a pane open indefinitely.
 */
const PROMPT_SIGNATURES: PromptSignature[] = [
  {
    id: 'workspace_trust',
    pattern:
      /do you trust|trust the contents|trust this (folder|workspace|directory)|信頼しますか|このフォルダを信頼/i,
    humanAction: 'answer the workspace trust prompt in the pane, once per path',
  },
  {
    id: 'sign_in',
    pattern:
      /sign in to continue|please (log ?in|sign ?in)|authenticate to continue|login required|ログインしてください/i,
    humanAction: 'sign the provider CLI in, then re-dispatch',
  },
  {
    id: 'device_code',
    pattern: /enter the code|device code|open the following url|first copy your one-time code/i,
    humanAction: 'complete the device-code flow shown in the pane',
  },
  {
    id: 'terms_or_consent',
    pattern:
      /accept the (terms|license)|do you agree|privacy notice|press enter to continue|利用規約に同意/i,
    humanAction: 'accept the terms shown in the pane',
  },
  {
    id: 'update_available',
    pattern: /update available.*\(y\/n\)|would you like to update|install the update\?/i,
    humanAction: 'answer or decline the update prompt, or update the CLI out of band',
  },
  {
    id: 'generic_confirm',
    // A yes/no affordance with nothing after it is a stop, whatever it asks.
    pattern: /\((y\/n|yes\/no)\)\s*$|^\s*[>❯]\s*(yes|no)\b/im,
    humanAction: 'answer the confirmation shown in the pane',
  },
];

/** Output that means "not finished starting" rather than "waiting for you". */
const STARTING_SIGNATURES =
  /starting|loading|initializ|connecting|booting|installing|downloading|fetching|起動中|読み込み中/i;

/**
 * Output that means the agent is taking work.
 *
 * Taken from real panes, because the first version was written from
 * imagination and missed every agent that was actually running: all three
 * of a mission's ready agents classified as `starting`. None of them says
 * "ready" or "how can I help". They show an input caret and a hint line:
 *
 *     agy (Antigravity CLI)      >            ? for shortcuts
 *     claude (Claude Code)       ❯            ⏵⏵ auto mode on (shift+tab to cycle)
 *
 * The caret alone on a line is the strongest signal; the hint lines are the
 * second, and survive a pane too narrow to render the caret row cleanly.
 */
const READY_SIGNATURES = new RegExp(
  [
    // An input caret alone on its line: > (agy), ❯ (claude), › (others).
    '^\\s*[>❯›]\\s*$',
    // Hint lines printed under an idle input.
    '\\? for shortcuts',
    'auto mode (on|off)',
    'shift\\+tab to cycle',
    // Generic phrasing some CLIs use.
    '^\\s*(?:agent\\s+)?ready\\s*$',
    'awaiting (input|instructions)',
    'how can i help',
    'what would you like',
    'type a message',
    '待機中',
  ].join('|'),
  'im'
);

/**
 * Classify what a pane's recent output means.
 *
 * Prompts are checked first and win: an agent that printed a banner, then a
 * ready line, then a trust prompt is not ready.
 */
export function classifyAgentReadiness(paneText: string): AgentReadiness {
  const text = String(paneText || '');
  if (!text.trim()) {
    return { state: 'starting', reason: 'pane has produced no output yet' };
  }

  // Only the tail matters. A trust prompt scrolled off an hour ago was
  // answered; one at the bottom of the screen is still waiting.
  const tail = text.split('\n').slice(-40).join('\n');

  for (const signature of PROMPT_SIGNATURES) {
    const match = signature.pattern.exec(tail);
    if (!match) continue;
    const lines = tail.split('\n');
    const index = lines.findIndex((line) => signature.pattern.test(line));
    const excerpt = lines
      .slice(Math.max(0, index - 2), Math.min(lines.length, index + 4))
      .join('\n')
      .trim();
    return {
      state: 'awaiting_human',
      reason: `agent is waiting for a person: ${signature.humanAction}`,
      promptExcerpt: excerpt,
      signatureId: signature.id,
    };
  }

  if (READY_SIGNATURES.test(tail)) {
    return { state: 'ready', reason: 'pane output indicates the agent is accepting work' };
  }
  if (STARTING_SIGNATURES.test(tail)) {
    return { state: 'starting', reason: 'pane output indicates the agent is still starting' };
  }
  // Output, no prompt, no ready marker. Treat as still starting rather than
  // ready: claiming readiness on ambiguous output is the failure this exists
  // to stop.
  return { state: 'starting', reason: 'pane output does not yet indicate readiness' };
}

export interface WaitForAgentReadinessInput {
  /** Reads the pane's recent output. Throwing means the pane is gone. */
  readPaneText: () => Promise<string> | string;
  /** Total budget. Default 60s — far below the 600s a silent wait costs. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** For logs. */
  label?: string;
}

/**
 * Wait for an agent to become ready, and stop early when it will not.
 *
 * The point is the early return. A prompt does not resolve itself, so the
 * moment one is detected this gives up and says what is on screen — turning
 * a ten-minute timeout into a few seconds and an actionable message.
 */
export async function waitForAgentReadiness(
  input: WaitForAgentReadinessInput
): Promise<AgentReadiness> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  const label = input.label || 'agent';
  const deadline = Date.now() + timeoutMs;
  let last: AgentReadiness = { state: 'starting', reason: 'not yet polled' };

  while (Date.now() < deadline) {
    let text: string;
    try {
      text = String(await input.readPaneText());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { state: 'unavailable', reason: `${label}: cannot read the pane (${message})` };
    }

    last = classifyAgentReadiness(text);
    if (last.state === 'ready') return last;
    if (last.state === 'awaiting_human') {
      // Nothing about waiting longer will answer a question.
      logger.warn(
        `[agent-runtime-readiness] ${label} is blocked: ${last.reason}` +
          (last.promptExcerpt ? `\n${last.promptExcerpt}` : '')
      );
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return {
    state: last.state === 'ready' ? 'ready' : 'unavailable',
    reason: `${label}: still ${last.state} after ${timeoutMs}ms (${last.reason})`,
  };
}

/**
 * One line for an operator, from a readiness result.
 *
 * A blocked agent is a request for a person, so it should read like one
 * rather than like a stack trace.
 */
export function describeAgentReadiness(readiness: AgentReadiness): string {
  if (readiness.state !== 'awaiting_human') return readiness.reason;
  return [
    `The agent has stopped and is waiting for you: ${readiness.reason}.`,
    readiness.promptExcerpt ? `\n${readiness.promptExcerpt}\n` : '',
    'Dispatch will keep failing until this is answered.',
  ]
    .filter(Boolean)
    .join(' ');
}
