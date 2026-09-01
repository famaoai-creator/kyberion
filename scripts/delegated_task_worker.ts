/** DH-12: one-shot process entrypoint for a durable continuable delegation. */

import {
  loadDelegatedTaskRecord,
  registerDelegatedTaskWorker,
  resumeDelegatedTask,
  wakeDelegatedTaskWorker,
} from '@agent/core/delegated-task-observability';
import { defineScript, isDirectScript } from './lib/harness.js';

function readArg(name: string, argv: string[]): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value?.trim()) throw new Error(`[DELEGATED_TASK_WORKER] missing ${name}`);
  return value.trim();
}

async function runWorker(argv: string[]): Promise<void> {
  const delegationId = readArg('--delegation-id', argv);
  const owner = readArg('--owner', argv);
  let settled = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let idleTimeout: ReturnType<typeof setTimeout> | undefined;

  async function finish(exitCode: number): Promise<void> {
    if (settled) return;
    settled = true;
    if (poll) clearInterval(poll);
    if (idleTimeout) clearTimeout(idleTimeout);
    process.exitCode = exitCode;
  }

  async function consumeWake(): Promise<void> {
    if (settled) return;
    try {
      await wakeDelegatedTaskWorker(delegationId, owner);
    } catch (error) {
      console.error(
        `[DELEGATED_TASK_WORKER] wake failed: ${error instanceof Error ? error.message : String(error)}`
      );
      await finish(1);
      return;
    }
    const record = loadDelegatedTaskRecord(delegationId);
    if (!record) {
      await finish(1);
      return;
    }
    if (record.status === 'cancelled') {
      await finish(0);
    } else if (record.status === 'failed') {
      await finish(1);
    }
  }

  const unregister = registerDelegatedTaskWorker(delegationId, {
    owner,
    handler: async () => {
      try {
        await resumeDelegatedTask(delegationId, '', {
          owner,
          requestedBy: owner,
          fromInbox: true,
        });
        await finish(0);
      } catch (error) {
        console.error(
          `[DELEGATED_TASK_WORKER] resume failed: ${error instanceof Error ? error.message : String(error)}`
        );
        await finish(1);
      }
    },
  });

  process.once('exit', () => unregister());
  poll = setInterval(() => {
    void consumeWake();
  }, 250);
  // Keep the explicit worker alive long enough to receive an enqueue that races
  // process startup, but bound a stale supervisor resource if no input arrives.
  idleTimeout = setTimeout(
    () => {
      void finish(2);
    },
    5 * 60 * 1000
  );
  void consumeWake();
}

export const runDelegatedTaskWorker = defineScript({
  name: 'delegated-task:worker',
  flags: [],
  run: ({ argv }) => runWorker(argv),
});

if (
  isDirectScript(import.meta.url, 'delegated_task_worker.ts') ||
  isDirectScript(import.meta.url, 'delegated_task_worker.js')
)
  void runDelegatedTaskWorker();
