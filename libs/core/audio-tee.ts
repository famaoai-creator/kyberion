/**
 * N-way audio tee — split one AsyncIterable of audio chunks into
 * independent consumers (STT, VAD, recorders) without re-pulling the
 * underlying source. Extracted from MeetingParticipationCoordinator so
 * the realtime voice loop and future duplex flows share one
 * implementation.
 *
 * Backpressure: each consumer buffers at most `maxQueuedChunks`; a slow
 * consumer drops chunks on the floor rather than stalling the others.
 */

import { logger } from './core.js';
import type { AudioChunk } from './meeting-session-types.js';

export interface AudioTeeOptions {
  /** Per-consumer buffer cap before chunks are dropped (default 64). */
  maxQueuedChunks?: number;
  /** Label used in warn logs when the source fails. */
  label?: string;
}

export function teeAudio(
  source: AsyncIterable<AudioChunk>,
  consumers: number,
  options: AudioTeeOptions = {}
): AsyncIterable<AudioChunk>[] {
  if (!Number.isInteger(consumers) || consumers < 1) {
    throw new Error(`[audio-tee] consumers must be a positive integer (got ${consumers})`);
  }
  const maxQueued = options.maxQueuedChunks ?? 64;
  const label = options.label ?? 'audio-tee';
  const queues: Array<AudioChunk[]> = Array.from({ length: consumers }, () => []);
  const resolvers: Array<Array<(chunk: AudioChunk | null) => void>> = Array.from(
    { length: consumers },
    () => []
  );
  let drained = false;

  const finish = (): void => {
    drained = true;
    for (let i = 0; i < consumers; i++) {
      while (resolvers[i].length) resolvers[i].shift()!(null);
    }
  };

  (async () => {
    for await (const chunk of source) {
      for (let i = 0; i < consumers; i++) {
        if (resolvers[i].length > 0) {
          resolvers[i].shift()!(chunk);
        } else if (queues[i].length < maxQueued) {
          queues[i].push(chunk);
        }
        // else: drop on the floor under sustained backpressure
      }
    }
    finish();
  })().catch((err: unknown) => {
    logger.warn(`[${label}] tee source failed: ${err instanceof Error ? err.message : err}`);
    finish();
  });

  function makeIter(idx: number): AsyncIterable<AudioChunk> {
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queues[idx].length > 0) {
            yield queues[idx].shift()!;
            continue;
          }
          if (drained) return;
          const chunk = await new Promise<AudioChunk | null>((resolve) => {
            resolvers[idx].push(resolve);
          });
          if (chunk === null) return;
          yield chunk;
        }
      },
    };
  }

  return Array.from({ length: consumers }, (_, idx) => makeIter(idx));
}
