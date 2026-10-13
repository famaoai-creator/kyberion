/** Poll the current co-session for handoffs addressed to a provider/participant. */
import { heartbeatCoSession, joinCoSession, listCoSessionHandoffs } from '@agent/core/co-session';
import { defineScript, isDirectScript } from '../lib/harness.js';

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_MAX_WAIT_MS = 300_000;

function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

export interface MonitorOptions {
  provider: string;
  participant_id: string;
  interval_ms: number;
  max_wait_ms: number;
}

export function parseMonitorArgs(argv: string[]): MonitorOptions {
  const provider = argValue(argv, '--provider') ?? 'agy';
  const participant_id = argValue(argv, '--participant-id') ?? `${provider}-monitor`;
  const interval = Number(argValue(argv, '--interval-ms'));
  const maxWait = Number(argValue(argv, '--max-wait-ms'));
  return {
    provider,
    participant_id,
    interval_ms: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_MS,
    max_wait_ms: Number.isFinite(maxWait) && maxWait > 0 ? maxWait : DEFAULT_MAX_WAIT_MS,
  };
}

async function main(print: (value: unknown) => void, options: MonitorOptions): Promise<void> {
  const startTime = Date.now();
  const { provider, participant_id: participantId } = options;

  // Ensure joined
  try {
    joinCoSession({
      provider,
      participant_id: participantId,
      note: 'co-session monitor listener active',
    });
  } catch {
    // The session may already be joined or no current session may exist yet.
  }

  while (Date.now() - startTime < options.max_wait_ms) {
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
          provider,
          participant_id: participantId,
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

    await new Promise((resolve) => setTimeout(resolve, options.interval_ms));
  }

  print({ status: 'timeout' });
}

export const runCoSessionMonitor = defineScript({
  name: 'co-session-monitor:poll',
  run: ({ argv, print }) => main(print, parseMonitorArgs(argv)),
});

if (isDirectScript(import.meta.url, 'poll.ts') || isDirectScript(import.meta.url, 'poll.js')) {
  void runCoSessionMonitor();
}
