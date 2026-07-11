import { logger } from './core.js';

/**
 * UX-02 Task 3: typing indicators for the text bridges. A long-running
 * conversation used to look like dead silence on Slack/Telegram/Discord.
 * The loop fires immediately, then every `intervalMs` (platform typing
 * states expire after ~5-10s), and stops when the reply is ready.
 * Indicator failures are cosmetic: warn once, never interrupt the reply.
 */
export function startBridgeTypingLoop(
  surface: string,
  send: () => unknown,
  intervalMs = 4000
): { stop: () => void } {
  let stopped = false;
  let warned = false;
  const fire = () => {
    if (stopped) return;
    Promise.resolve()
      .then(() => send())
      .catch((err) => {
        if (!warned) {
          warned = true;
          logger.warn(
            `[${surface}] typing indicator failed (suppressing repeats): ${err instanceof Error ? err.message : String(err)}`
          );
        }
      });
  };
  fire();
  const timer = setInterval(fire, intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * For surfaces with no typing API (iMessage): send a one-time "working on
 * it" note only when processing outlives `delayMs`, so quick replies stay
 * clean while long ones stop reading as silence.
 */
export function scheduleBridgeProcessingNote(
  surface: string,
  send: () => unknown,
  delayMs = 5000
): { cancel: () => void } {
  const timer = setTimeout(() => {
    Promise.resolve()
      .then(() => send())
      .catch((err) => {
        logger.warn(
          `[${surface}] processing note failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }, delayMs);
  timer.unref?.();
  return {
    cancel() {
      clearTimeout(timer);
    },
  };
}
