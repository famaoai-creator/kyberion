import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  egress: vi.fn(),
  record: vi.fn(),
  base: '',
}));

vi.mock('../reasoning/reasoning-egress-scope.js', () => ({
  assertReasoningEgressAllowed: mocks.egress,
}));
vi.mock('../analysis/metrics.js', () => ({
  metrics: { record: mocks.record, increment: vi.fn(), observe: vi.fn() },
}));
// Hermetic: route the governed scratch helper to a per-run ledger + root.
vi.mock('../workforce/workspace-ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workforce/workspace-ledger.js')>();
  const ledgerOptions = () => ({
    ledgerPath: path.join(mocks.base, 'workspaces', 'ledger.json'),
    allowedRoots: [path.join(mocks.base, 'workspaces')],
  });
  return {
    ...actual,
    createScratchWorkspace: (owner: Parameters<typeof actual.createScratchWorkspace>[0]) =>
      actual.createScratchWorkspace(owner, {
        ...ledgerOptions(),
        root: path.join(mocks.base, 'workspaces'),
      }),
    deleteRegisteredWorkspace: (id: string) =>
      actual.deleteRegisteredWorkspace(id, ledgerOptions()),
  };
});

import * as pathResolver from '../path-resolver.js';
import { STRUCTURED_REASONING_SYSTEM_PROMPT } from '../reasoning/structured-reasoning.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync } from '../secure-io.js';
import {
  buildCursorSdkBackendFromEnv,
  buildCursorSdkOptionsFromEnv,
  CursorSdkReasoningBackend,
  probeCursorSdkAvailability,
} from './cursor-sdk-reasoning-backend.js';
import {
  resetCursorSdkCapabilityCache,
  runCursorSdkText,
  type CursorSdkCreateAgentOptions,
  type CursorSdkRunResult,
  type CursorSdkRuntime,
} from './cursor-sdk-query.js';

mocks.base = pathResolver.sharedTmp(`vitest-cursor-sdk/${randomUUID()}`);

interface FakeRuntime {
  runtime: CursorSdkRuntime;
  created: CursorSdkCreateAgentOptions[];
  sent: string[];
  closed: () => number;
  cancelled: () => number;
}

function fakeRuntime(
  results: Array<CursorSdkRunResult | Error>,
  options: { rejectCreate?: (o: CursorSdkCreateAgentOptions) => Error | undefined } = {}
): FakeRuntime {
  const created: CursorSdkCreateAgentOptions[] = [];
  const sent: string[] = [];
  let closed = 0;
  let cancelled = 0;
  const queue = [...results];
  return {
    created,
    sent,
    closed: () => closed,
    cancelled: () => cancelled,
    runtime: {
      async createAgent(opts) {
        const rejection = options.rejectCreate?.(opts);
        if (rejection) throw rejection;
        created.push(opts);
        return {
          async send(message: string) {
            sent.push(message);
            return {
              async wait() {
                const next = queue.shift();
                if (!next) throw new Error('no queued result');
                if (next instanceof Error) throw next;
                return next;
              },
              async cancel() {
                cancelled += 1;
              },
            };
          },
          close() {
            closed += 1;
          },
        };
      },
    },
  };
}

const finished = (result: string, usage = true): CursorSdkRunResult => ({
  status: 'finished',
  result,
  ...(usage
    ? { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 } }
    : {}),
});

beforeEach(() => {
  mocks.egress.mockReset();
  mocks.record.mockReset();
  resetCursorSdkCapabilityCache();
});

afterAll(() => {
  if (safeExistsSync(mocks.base)) safeRmSync(mocks.base, { recursive: true, force: true });
});

describe('cursor-sdk-reasoning-backend', () => {
  it('runs a tool-less completion and returns the final text', async () => {
    safeMkdir(mocks.base, { recursive: true });
    const fake = fakeRuntime([finished('pong')]);
    const backend = new CursorSdkReasoningBackend({
      runtime: fake.runtime,
      apiKey: 'test-key',
      model: 'composer-2.5',
    });

    await expect(backend.prompt('ping')).resolves.toBe('pong');

    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toMatchObject({ apiKey: 'test-key', model: 'composer-2.5' });
    // Default: system prompt folded into the message (native path is opt-in).
    expect(fake.created[0]!.systemPrompt).toBeUndefined();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toContain('focused reasoning sub-agent');
    expect(fake.sent[0]).toContain('ping');
    expect(mocks.egress).toHaveBeenCalledWith('cursor-sdk');
    expect(fake.closed()).toBeGreaterThan(0);
  });

  it('uses scratch directories for cwd and store, and removes them afterwards', async () => {
    const fake = fakeRuntime([finished('ok')]);
    const backend = new CursorSdkReasoningBackend({ runtime: fake.runtime, apiKey: 'k' });
    await backend.prompt('x');

    const { cwd, storeDir } = fake.created[0]!;
    expect(cwd).not.toBe(storeDir);
    expect(cwd.startsWith(path.join(mocks.base, 'workspaces'))).toBe(true);
    expect(storeDir.startsWith(path.join(mocks.base, 'workspaces'))).toBe(true);
    expect(safeExistsSync(cwd)).toBe(false);
    expect(safeExistsSync(storeDir)).toBe(false);
  });

  it('parses and validates structured ops with the prompt-enforced shape hint', async () => {
    const fake = fakeRuntime([
      finished(
        JSON.stringify({
          hypotheses: [{ id: 'H-a-1', proposed_by: 'a', content: 'x', status: 'pending' }],
        })
      ),
    ]);
    const backend = new CursorSdkReasoningBackend({ runtime: fake.runtime, apiKey: 'k' });

    const result = await backend.divergePersonas({ topic: 't', personas: ['a'] });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('H-a-1');
    expect(fake.sent[0]).toContain('Respond with exactly this JSON shape');
  });

  it('rejects structured output that still fails validation after one repair round', async () => {
    const bad = JSON.stringify({ unexpected: true });
    const fake = fakeRuntime([finished(bad), finished(bad)]);
    const backend = new CursorSdkReasoningBackend({ runtime: fake.runtime, apiKey: 'k' });

    await expect(backend.divergePersonas({ topic: 't', personas: ['a'] })).rejects.toThrow(
      /structured-reasoning/u
    );
    expect(fake.sent).toHaveLength(2);
  });

  it('repairs invalid structured output once, feeding the validation error back', async () => {
    const fake = fakeRuntime([
      finished(JSON.stringify({ unexpected: true })),
      finished(
        JSON.stringify({
          hypotheses: [{ id: 'H-a-1', proposed_by: 'a', content: 'x', status: 'pending' }],
        })
      ),
    ]);
    const backend = new CursorSdkReasoningBackend({ runtime: fake.runtime, apiKey: 'k' });

    await expect(backend.divergePersonas({ topic: 't', personas: ['a'] })).resolves.toHaveLength(1);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]).toContain('Your previous reply was rejected');
    expect(fake.sent[1]).toContain('schema validation failed');
  });

  it('folds the system prompt into the user prompt when the account has not enabled it', async () => {
    const fake = fakeRuntime([finished('folded')], {
      rejectCreate: (o) =>
        o.systemPrompt ? new Error('system prompt is not enabled: --system-prompt') : undefined,
    });
    const backend = new CursorSdkReasoningBackend({
      runtime: fake.runtime,
      apiKey: 'k',
      nativeSystemPrompt: true,
    });

    await expect(backend.prompt('hello')).resolves.toBe('folded');

    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]!.systemPrompt).toBeUndefined();
    expect(fake.sent[0]).toContain('focused reasoning sub-agent');
    expect(fake.sent[0]).toContain('hello');
  });

  it('folds the system prompt when the run (not create) rejects it, then remembers the answer', async () => {
    const fake = fakeRuntime([
      {
        status: 'error',
        error: {
          message: 'Custom system prompt is not enabled for this account.',
          code: 'invalid_argument',
        },
      },
      finished('first'),
      finished('second'),
    ]);
    const backend = new CursorSdkReasoningBackend({
      runtime: fake.runtime,
      apiKey: 'k',
      nativeSystemPrompt: true,
    });

    await expect(backend.prompt('one')).resolves.toBe('first');
    await expect(backend.prompt('two')).resolves.toBe('second');

    // Attempt 1: native systemPrompt (rejected at run). Attempt 2: folded.
    // Call two: the learned answer skips the native path entirely.
    expect(fake.created.map((c) => Boolean(c.systemPrompt))).toEqual([true, false, false]);
    expect(fake.sent[1]).toContain('focused reasoning sub-agent');
    expect(fake.sent[2]).toContain('focused reasoning sub-agent');
  });

  it('isolates concurrent calls in distinct scratch directories and cleans them all', async () => {
    const fake = fakeRuntime([finished('a'), finished('b'), finished('c')]);
    const backend = new CursorSdkReasoningBackend({ runtime: fake.runtime, apiKey: 'k' });

    const answers = await Promise.all([
      backend.prompt('1'),
      backend.prompt('2'),
      backend.prompt('3'),
    ]);

    expect([...answers].sort()).toEqual(['a', 'b', 'c']);
    const dirs = fake.created.flatMap((c) => [c.cwd, c.storeDir]);
    expect(new Set(dirs).size).toBe(6);
    for (const dir of dirs) expect(safeExistsSync(dir)).toBe(false);
  });

  it('sends the system prompt natively only when opted in', async () => {
    const fake = fakeRuntime([finished('native')]);
    const backend = new CursorSdkReasoningBackend({
      runtime: fake.runtime,
      apiKey: 'k',
      nativeSystemPrompt: true,
    });

    await expect(backend.prompt('hi')).resolves.toBe('native');
    expect(fake.created[0]!.systemPrompt).toContain('focused reasoning sub-agent');
    expect(fake.sent).toEqual(['hi']);
  });

  it.each([
    'Cannot use this model: nope. Available models: auto, composer-2.5',
    'invalid_model: nope',
    'The model "nope" is not available for this account',
    'model not found: nope',
    'unknown model nope',
  ])('points a model error (%s) at the model override', async (message) => {
    const fake = fakeRuntime([{ status: 'error', error: { message, code: 'invalid_argument' } }]);
    const backend = new CursorSdkReasoningBackend({
      runtime: fake.runtime,
      apiKey: 'k',
      model: 'nope',
    });

    await expect(backend.prompt('x')).rejects.toThrow(/next: set KYBERION_CURSOR_SDK_MODEL/u);
  });

  it('points an invalid model at the model override and keeps the available list', async () => {
    const fake = fakeRuntime([
      {
        status: 'error',
        error: {
          message: 'Cannot use this model: nope. Available models: auto, composer-2.5',
          code: 'invalid_argument',
        },
      },
    ]);
    const backend = new CursorSdkReasoningBackend({
      runtime: fake.runtime,
      apiKey: 'k',
      model: 'nope',
    });

    await expect(backend.prompt('x')).rejects.toThrow(
      /Available models: auto, composer-2\.5.*next: set KYBERION_CURSOR_SDK_MODEL/su
    );
  });

  it('does not append the model hint to unrelated errors', async () => {
    const fake = fakeRuntime([
      { status: 'error', error: { message: 'quota exceeded', code: 'quota' } },
    ]);
    const backend = new CursorSdkReasoningBackend({ runtime: fake.runtime, apiKey: 'k' });
    await expect(backend.prompt('x')).rejects.toThrow(/run failed: quota exceeded$/u);
  });

  it('reads the native system prompt opt-in from the governed env accessor', () => {
    expect(
      buildCursorSdkOptionsFromEnv({ KYBERION_CURSOR_SDK_NATIVE_SYSTEM_PROMPT: 'true' })
    ).toEqual({
      nativeSystemPrompt: true,
    });
    expect(buildCursorSdkOptionsFromEnv({})).toEqual({});
  });

  it('surfaces a failed run as an error and records an error metric', async () => {
    const fake = fakeRuntime([
      { status: 'error', error: { message: 'quota exceeded', code: 'quota' } },
    ]);
    const backend = new CursorSdkReasoningBackend({ runtime: fake.runtime, apiKey: 'k' });

    await expect(backend.prompt('x')).rejects.toThrow(/run failed: quota exceeded/u);
    expect(mocks.record).toHaveBeenCalledWith(
      'cursor-sdk',
      expect.any(Number),
      'error',
      expect.objectContaining({ model: 'composer-2.5' })
    );
  });

  it('treats an empty finished run as an error', async () => {
    const fake = fakeRuntime([finished('   ', false)]);
    const backend = new CursorSdkReasoningBackend({ runtime: fake.runtime, apiKey: 'k' });
    await expect(backend.prompt('x')).rejects.toThrow(/without text/u);
  });

  it('cancels the run when the timeout elapses', async () => {
    const fake = fakeRuntime([]);
    // wait() never settles
    fake.runtime.createAgent = async () => ({
      async send() {
        return {
          wait: () => new Promise<CursorSdkRunResult>(() => undefined),
          async cancel() {
            return undefined;
          },
        };
      },
      close() {
        return undefined;
      },
    });
    const backend = new CursorSdkReasoningBackend({
      runtime: fake.runtime,
      apiKey: 'k',
      timeoutMs: 20,
    });
    await expect(backend.prompt('x')).rejects.toThrow(/timed out after \d+ms/u);
  });

  it('cancels the run when the caller aborts', async () => {
    const controller = new AbortController();
    let cancelled = 0;
    const runtime: CursorSdkRuntime = {
      async createAgent() {
        return {
          async send() {
            return {
              wait: () =>
                new Promise<CursorSdkRunResult>((resolve) => {
                  controller.signal.addEventListener('abort', () =>
                    resolve({ status: 'cancelled' })
                  );
                }),
              async cancel() {
                cancelled += 1;
              },
            };
          },
          close() {
            return undefined;
          },
        };
      },
    };
    const backend = new CursorSdkReasoningBackend({ runtime, apiKey: 'k' });
    const pending = backend.prompt('x', { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow(/cancelled/u);
    expect(cancelled).toBe(1);
  });

  it('cancels the run when the signal aborted between send and wait', async () => {
    const controller = new AbortController();
    let cancelled = 0;
    const runtime: CursorSdkRuntime = {
      async createAgent() {
        return {
          async send() {
            // Abort lands after send() resolves but before waitForRun can
            // attach its listener — the run must still be cancelled.
            const run = {
              wait: () =>
                new Promise<CursorSdkRunResult>((resolve) =>
                  setTimeout(() => resolve({ status: 'cancelled' }), 5)
                ),
              async cancel() {
                cancelled += 1;
              },
            };
            controller.abort();
            return run;
          },
          close() {
            return undefined;
          },
        };
      },
    };
    const backend = new CursorSdkReasoningBackend({ runtime, apiKey: 'k' });
    await expect(backend.prompt('x', { signal: controller.signal })).rejects.toThrow(/cancelled/u);
    expect(cancelled).toBe(1);
  });

  it('times out a stalled createAgent and closes the late-resolving agent', async () => {
    vi.useFakeTimers();
    try {
      let closed = 0;
      const runtime: CursorSdkRuntime = {
        createAgent() {
          return new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  async send() {
                    return {
                      wait: () => Promise.resolve(finished('late')),
                      async cancel() {},
                    };
                  },
                  close() {
                    closed += 1;
                  },
                }),
              100
            )
          );
        },
      };
      const backend = new CursorSdkReasoningBackend({
        runtime,
        apiKey: 'k',
        timeoutMs: 20,
      });
      const pending = backend.prompt('x');
      const assertion = expect(pending).rejects.toThrow(/timed out after /u);
      await vi.advanceTimersByTimeAsync(30);
      await assertion;
      // The create resolves later than the deadline — the agent is closed, not leaked.
      await vi.advanceTimersByTimeAsync(100);
      expect(closed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a contextMode without a session before touching the SDK', async () => {
    const fake = fakeRuntime([finished('never')]);
    await expect(
      runCursorSdkText(
        { systemPrompt: 's', userPrompt: 'u', contextMode: 'continue' },
        { runtime: fake.runtime, apiKey: 'k' }
      )
    ).rejects.toThrow(/contextMode and session must be passed together/u);
    expect(fake.created).toHaveLength(0);
  });

  it('bounds a stalled createAgent inside a continued session too', async () => {
    vi.useFakeTimers();
    try {
      const runtime: CursorSdkRuntime = {
        createAgent() {
          return new Promise<never>(() => undefined);
        },
      };
      const backend = new CursorSdkReasoningBackend({
        runtime,
        apiKey: 'k',
        timeoutMs: 20,
      });
      const pending = backend.prompt('x', { context_mode: 'continue' });
      const assertion = expect(pending).rejects.toThrow(/timed out after /u);
      await vi.advanceTimersByTimeAsync(30);
      await assertion;
      await backend.resetSession();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails before any SDK call when no API key resolves', async () => {
    const fake = fakeRuntime([finished('never')]);
    const backend = new CursorSdkReasoningBackend({
      runtime: fake.runtime,
      env: { CURSOR_API_KEY: '' },
    });
    const previous = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    try {
      await expect(backend.prompt('x')).rejects.toThrow(/CURSOR_API_KEY is not configured/u);
      expect(fake.created).toHaveLength(0);
      // The prompt never left the process, so no spend is attributed.
      expect(mocks.record).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) process.env.CURSOR_API_KEY = previous;
    }
  });

  it('propagates an egress denial before touching the SDK', async () => {
    mocks.egress.mockImplementation(() => {
      throw new Error('[REASONING_EGRESS_DENIED] cursor-sdk');
    });
    const fake = fakeRuntime([finished('never')]);
    const backend = new CursorSdkReasoningBackend({ runtime: fake.runtime, apiKey: 'k' });
    await expect(backend.prompt('x')).rejects.toThrow(/REASONING_EGRESS_DENIED/u);
    expect(fake.created).toHaveLength(0);
  });

  it('maps SDK token usage into the usage report', async () => {
    const fake = fakeRuntime([finished('ok')]);
    const backend = new CursorSdkReasoningBackend({ runtime: fake.runtime, apiKey: 'k' });
    await backend.prompt('x');

    expect(mocks.record).toHaveBeenCalledWith(
      'cursor-sdk',
      expect.any(Number),
      'success',
      expect.objectContaining({ model: 'composer-2.5', agent: 'cursor-sdk' })
    );
  });
});

describe('cursor-sdk availability', () => {
  it('is available when CURSOR_API_KEY is in the supplied environment', () => {
    expect(probeCursorSdkAvailability({ CURSOR_API_KEY: 'k' })).toEqual({ available: true });
  });

  it('is unavailable, with a remediation hint, when no key resolves', () => {
    const result = probeCursorSdkAvailability({});
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/secret introduce cursor API_KEY/u);
  });

  it('builds a backend from env and honors the model override', () => {
    const backend = buildCursorSdkBackendFromEnv({
      CURSOR_API_KEY: 'k',
      KYBERION_CURSOR_SDK_MODEL: 'composer-2.5-fast',
    } as NodeJS.ProcessEnv);
    expect(backend?.name).toBe('cursor-sdk');
  });

  it('returns null when unavailable', () => {
    expect(buildCursorSdkBackendFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('reads provider env through the governed accessor and not process.env directly', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/provider/cursor-sdk-reasoning-backend.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/process\.env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });
});

describe('cursor-sdk continued conversation (context_mode)', () => {
  const dirsOf = (fake: FakeRuntime): string[] => fake.created.flatMap((c) => [c.cwd, c.storeDir]);

  it('keeps stateless calls independent when context_mode is not set', async () => {
    const fake = fakeRuntime([finished('a'), finished('b')]);
    const backend = new CursorSdkReasoningBackend({ runtime: fake.runtime, apiKey: 'k' });

    await backend.prompt('one');
    await backend.prompt('two');

    expect(fake.created).toHaveLength(2);
  });

  it('continues on one agent, sends the system prompt once, and keeps the scratch dirs', async () => {
    const fake = fakeRuntime([finished('first'), finished('second')]);
    const backend = new CursorSdkReasoningBackend({ runtime: fake.runtime, apiKey: 'k' });

    await expect(backend.prompt('one', { context_mode: 'continue' })).resolves.toBe('first');
    await expect(backend.prompt('two', { context_mode: 'continue' })).resolves.toBe('second');

    expect(fake.created).toHaveLength(1);
    expect(fake.sent[0]).toContain('focused reasoning sub-agent');
    expect(fake.sent[1]).toBe('two');
    for (const dir of dirsOf(fake)) expect(safeExistsSync(dir)).toBe(true);

    await backend.resetSession();
    expect(fake.closed()).toBe(1);
    for (const dir of dirsOf(fake)) expect(safeExistsSync(dir)).toBe(false);
  });

  it('resends the system prompt when it changes between turns', async () => {
    const fake = fakeRuntime([finished('a'), finished('b')]);
    const backend = new CursorSdkReasoningBackend({ runtime: fake.runtime, apiKey: 'k' });

    await backend.prompt('one', { context_mode: 'continue' });
    await backend.delegateTask('do it', undefined, { context_mode: 'continue' });

    expect(fake.created).toHaveLength(1);
    expect(fake.sent[1]).toContain('Task: do it');
    expect(fake.sent[1]).toContain(STRUCTURED_REASONING_SYSTEM_PROMPT.trim());
    await backend.resetSession();
  });

  it("starts a new conversation on 'fresh' and closes the previous agent", async () => {
    const fake = fakeRuntime([finished('a'), finished('b'), finished('c')]);
    const backend = new CursorSdkReasoningBackend({ runtime: fake.runtime, apiKey: 'k' });

    await backend.prompt('one', { context_mode: 'continue' });
    await backend.prompt('two', { context_mode: 'fresh' });
    await backend.prompt('three', { context_mode: 'continue' });

    expect(fake.created).toHaveLength(2);
    expect(fake.closed()).toBe(1);
    expect(fake.sent[1]).toContain('focused reasoning sub-agent');
    expect(fake.sent[2]).toBe('three');
    await backend.resetSession();
    for (const dir of dirsOf(fake)) expect(safeExistsSync(dir)).toBe(false);
  });

  it('starts over when the model changes', async () => {
    const fake = fakeRuntime([finished('a'), finished('b')]);
    const backend = new CursorSdkReasoningBackend({ runtime: fake.runtime, apiKey: 'k' });

    await backend.prompt('one', { context_mode: 'continue', model: 'auto' });
    await backend.prompt('two', { context_mode: 'continue', model: 'composer-2.5' });

    expect(fake.created.map((c) => c.model)).toEqual(['auto', 'composer-2.5']);
    expect(fake.closed()).toBe(1);
    await backend.resetSession();
  });

  it('discards the conversation after a failed turn (fail closed)', async () => {
    const fake = fakeRuntime([
      finished('a'),
      { status: 'error', error: { message: 'boom' } },
      finished('c'),
    ]);
    const backend = new CursorSdkReasoningBackend({ runtime: fake.runtime, apiKey: 'k' });

    await backend.prompt('one', { context_mode: 'continue' });
    await expect(backend.prompt('two', { context_mode: 'continue' })).rejects.toThrow(/boom/u);
    expect(fake.closed()).toBe(1);
    await backend.prompt('three', { context_mode: 'continue' });

    expect(fake.created).toHaveLength(2);
    expect(fake.sent[2]).toContain('focused reasoning sub-agent');
    await backend.resetSession();
  });

  it('serializes concurrent continued turns in FIFO order', async () => {
    const events: string[] = [];
    const gates: Array<() => void> = [];
    let created = 0;
    const runtime: CursorSdkRuntime = {
      async createAgent() {
        created += 1;
        return {
          async send(message: string) {
            events.push(`send:${message.split('\n').pop()}`);
            return {
              wait: () =>
                new Promise<CursorSdkRunResult>((resolve) => {
                  gates.push(() => {
                    events.push(`done:${message.split('\n').pop()}`);
                    resolve(finished('ok'));
                  });
                }),
              async cancel() {},
            };
          },
          close() {},
        };
      },
    };
    const backend = new CursorSdkReasoningBackend({ runtime, apiKey: 'k' });

    const first = backend.prompt('A', { context_mode: 'continue' });
    const second = backend.prompt('B', { context_mode: 'continue' });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    // B must not have been sent while A is still running.
    expect(events).toEqual(['send:A']);
    gates[0]!();
    await first;
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1]!();
    await second;

    expect(events).toEqual(['send:A', 'done:A', 'send:B', 'done:B']);
    expect(created).toBe(1);
    await backend.resetSession();
  });

  it('rejects a queued turn that is aborted before it starts', async () => {
    const gates: Array<() => void> = [];
    const runtime: CursorSdkRuntime = {
      async createAgent() {
        return {
          async send() {
            return {
              wait: () =>
                new Promise<CursorSdkRunResult>((resolve) => {
                  gates.push(() => resolve(finished('ok')));
                }),
              async cancel() {},
            };
          },
          close() {},
        };
      },
    };
    const backend = new CursorSdkReasoningBackend({ runtime, apiKey: 'k' });
    const controller = new AbortController();

    const first = backend.prompt('A', { context_mode: 'continue' });
    const second = backend.prompt('B', { context_mode: 'continue', signal: controller.signal });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    controller.abort();
    gates[0]!();
    await first;

    await expect(second).rejects.toThrow(/aborted before start/u);
    await backend.resetSession();
  });

  it('releases the agent and scratch dirs after the idle TTL', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeRuntime([finished('a'), finished('b')]);
      const backend = new CursorSdkReasoningBackend({
        runtime: fake.runtime,
        apiKey: 'k',
        sessionIdleTtlMs: 1000,
      });

      await backend.prompt('one', { context_mode: 'continue' });
      await vi.advanceTimersByTimeAsync(500);
      expect(fake.closed()).toBe(0);
      await vi.advanceTimersByTimeAsync(600);

      expect(fake.closed()).toBe(1);
      for (const dir of dirsOf(fake)) expect(safeExistsSync(dir)).toBe(false);

      // The next continued call transparently starts a new conversation.
      await backend.prompt('two', { context_mode: 'continue' });
      expect(fake.created).toHaveLength(2);
      expect(fake.sent[1]).toContain('focused reasoning sub-agent');
      await backend.resetSession();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the idle TTL from the governed env accessor', () => {
    expect(
      buildCursorSdkOptionsFromEnv({ KYBERION_CURSOR_SDK_SESSION_IDLE_TTL_MS: '60000' })
    ).toEqual({ sessionIdleTtlMs: 60000 });
    expect(
      buildCursorSdkOptionsFromEnv({ KYBERION_CURSOR_SDK_SESSION_IDLE_TTL_MS: 'nope' })
    ).toEqual({});
  });
});
