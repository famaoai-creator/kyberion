import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const secureIo = vi.hoisted(() => {
  const abs = (filePath: string) =>
    path.isAbsolute(filePath) ? filePath : path.join(process.env.KYBERION_ROOT || '', filePath);
  return {
    safeAppendFileSync: (filePath: string, data: string) => {
      fs.mkdirSync(path.dirname(abs(filePath)), { recursive: true });
      fs.appendFileSync(abs(filePath), data, 'utf8');
    },
    safeMkdir: (dirPath: string) => fs.mkdirSync(abs(dirPath), { recursive: true }),
    safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
      options.encoding === null
        ? fs.readFileSync(abs(filePath))
        : fs.readFileSync(abs(filePath), 'utf8'),
  };
});

vi.mock('./secure-io.js', () => secureIo);
vi.mock('./core.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { executeAdfSteps } from './adf-engine.js';
import {
  WorkerEventStream,
  attachJsonlRecorder,
  buildWorkerEventStepHooks,
  getDefaultWorkerEventStream,
  readWorkerEventStreamJsonl,
  resetDefaultWorkerEventStream,
} from './worker-event-stream.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `worker-event-stream-${randomUUID()}-`));
  process.env.KYBERION_ROOT = tmpRoot;
  resetDefaultWorkerEventStream();
});

afterEach(() => {
  resetDefaultWorkerEventStream();
  delete process.env.KYBERION_ROOT;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('WorkerEventStream', () => {
  it('broadcasts validated envelopes with monotonic seq to every subscriber', () => {
    const stream = new WorkerEventStream({ pipeline_id: 'demo' });
    const seenA: string[] = [];
    const seenB: number[] = [];
    stream.subscribe((event) => seenA.push(event.type));
    const unsubscribe = stream.subscribe((event) => seenB.push(event.seq));

    stream.emit('turn_begin', { kind: 'pipeline' });
    stream.emit('status_update', { context_pct: 12 });
    unsubscribe();
    stream.emit('turn_end', { status: 'succeeded' });

    expect(seenA).toEqual(['turn_begin', 'status_update', 'turn_end']);
    expect(seenB).toEqual([0, 1]);
  });

  it('isolates a failing listener (fail-open) and keeps delivering', () => {
    const stream = new WorkerEventStream();
    const seen: string[] = [];
    stream.subscribe(() => {
      throw new Error('broken consumer');
    });
    stream.subscribe((event) => seen.push(event.type));

    expect(() => stream.emit('notification', { text: 'hi' })).not.toThrow();
    expect(seen).toEqual(['notification']);
  });

  it('rejects unknown event types at the contract boundary', () => {
    const stream = new WorkerEventStream();
    expect(() => stream.emit('nonsense' as never, {})).toThrow();
  });

  it('records to jsonl and replays the identical envelope sequence', () => {
    const stream = new WorkerEventStream({ mission_id: 'MSN-1' });
    const file = 'active/shared/tmp/worker-events-test/run.jsonl';
    const detach = attachJsonlRecorder(stream, file);
    const emitted = [
      stream.emit('turn_begin', { kind: 'pipeline', pipeline_id: 'p1' }),
      stream.emit('step_begin', { op: 'system:exec', step_number: 1 }),
      stream.emit('step_end', { op: 'system:exec', step_number: 1, status: 'success' }),
      stream.emit('turn_end', { status: 'succeeded' }),
    ];
    detach();
    stream.emit('notification', { text: 'not recorded' });

    const replayed = readWorkerEventStreamJsonl(file);
    expect(replayed).toEqual(emitted);
  });

  it('skips corrupt lines during replay without poisoning the rest', () => {
    const stream = new WorkerEventStream();
    const file = 'active/shared/tmp/worker-events-test/corrupt.jsonl';
    attachJsonlRecorder(stream, file);
    stream.emit('turn_begin', {});
    secureIo.safeAppendFileSync(file, 'not-json\n{"type":"bogus"}\n');
    stream.emit('turn_end', {});

    const replayed = readWorkerEventStreamJsonl(file);
    expect(replayed.map((event) => event.type)).toEqual(['turn_begin', 'turn_end']);
  });

  it('exposes a resettable process-wide default stream', () => {
    const first = getDefaultWorkerEventStream();
    expect(getDefaultWorkerEventStream()).toBe(first);
    resetDefaultWorkerEventStream();
    expect(getDefaultWorkerEventStream()).not.toBe(first);
  });
});

describe('pipeline e2e over the event stream (KC-02 acceptance)', () => {
  it('asserts the exact event sequence of a representative pipeline run', async () => {
    const stream = new WorkerEventStream({ pipeline_id: 'demo-pipeline' });
    const events: string[] = [];
    stream.subscribe((event) =>
      events.push(
        event.type === 'step_begin' || event.type === 'step_end'
          ? `${event.type}:${event.payload.op}:${event.payload.status ?? ''}`
          : event.type
      )
    );
    const stepHooks = buildWorkerEventStepHooks(stream);

    stream.emit('turn_begin', { kind: 'pipeline', pipeline_id: 'demo-pipeline' });
    const result = await executeAdfSteps(
      [
        { type: 'capture', op: 'fetch', params: { url: 'stub://x' } },
        { type: 'apply', op: 'notify', params: { channel: 'ops' } },
      ],
      {},
      { maxSteps: 10, timeoutMs: 5_000 },
      {
        capture: async (_op, _params, ctx) => ({ ...ctx, fetched: true }),
        transform: async (_op, _params, ctx) => ctx,
        apply: async (_op, _params, ctx) => ctx,
      },
      {
        beforeStep: (step, stepNumber) => stepHooks.beforeStep(step, stepNumber),
        afterStep: (step, stepNumber, _ctx, outcome) =>
          stepHooks.afterStep(step, stepNumber, outcome),
      }
    );
    stream.emit('turn_end', { status: result.status });

    expect(result.status).toBe('succeeded');
    expect(events).toEqual([
      'turn_begin',
      'step_begin:fetch:',
      'step_end:fetch:success',
      'step_begin:notify:',
      'step_end:notify:success',
      'turn_end',
    ]);
  });
});
