/** Poll the current co-session for handoffs addressed to agy. */
import { heartbeatCoSession, joinCoSession, listCoSessionHandoffs } from '@agent/core/co-session';
import { defineScript, isDirectScript } from '../lib/harness.js';

const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 300_000;

async function main(print: (value: unknown) => void): Promise<void> {
  const startTime = Date.now();
  const provider = 'agy';
  const participantId = 'agy-antigravity';

  // Ensure joined
  try {
    joinCoSession({
      provider,
      participant_id: participantId,
      note: 'Antigravity reactive listener active',
    });
  } catch {
    // The session may already be joined or no current session may exist yet.
  }

  while (Date.now() - startTime < MAX_WAIT_MS) {
    try {
      heartbeatCoSession({
        provider,
        participant_id: participantId,
      });

      const pending = listCoSessionHandoffs(undefined, { pendingOnly: true }).filter(
        (h) =>
          h.to_provider === provider ||
          h.to_participant_id === participantId ||
          (!h.to_provider && !h.to_participant_id)
      );

      if (pending.length > 0) {
        print({
          status: 'new_handoff',
          handoffs: pending.map(({ handoff_id, session_id, kind, subject, created_at }) => ({
            handoff_id,
            session_id,
            kind,
            ...(subject ? { subject } : {}),
            created_at,
          })),
        });
        return;
      }
    } catch {
      // Ignore transient file lock / session lifecycle errors and poll again.
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  print({ status: 'timeout' });
}

export const runCoSessionMonitor = defineScript({
  name: 'co-session-monitor:poll',
  run: ({ print }) => main(print),
});

if (isDirectScript(import.meta.url, 'poll.ts') || isDirectScript(import.meta.url, 'poll.js')) {
  void runCoSessionMonitor();
}
