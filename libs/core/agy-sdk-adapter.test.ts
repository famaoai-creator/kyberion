import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AgySdkAdapter, normalizeAgySdkBridgeMessage } from './agy-sdk-adapter.js';

function fakeBridge(responseFor: (request: Record<string, unknown>) => Record<string, unknown>) {
  const child = new EventEmitter() as any;
  child.pid = 4321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn(() => {
    child.emit('close', 0, null);
    return true;
  });
  child.stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
    queueMicrotask(() => {
      const response = responseFor(request);
      const delayMs = Number(response.__delayMs ?? 0);
      delete response.__delayMs;
      const send = () => child.stdout.write(`${JSON.stringify(response)}\n`);
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });
  queueMicrotask(() => child.stdout.write('{"event":"ready","pid":4321,"sdk":"test"}\n'));
  return child;
}

describe('AgySdkAdapter', () => {
  let adapter: AgySdkAdapter | undefined;

  afterEach(async () => {
    await adapter?.shutdown();
  });

  it('normalizes ready and request bridge messages', () => {
    expect(normalizeAgySdkBridgeMessage({ event: 'ready', pid: 4321, sdk: 'test' })).toEqual({
      event: 'ready',
      pid: 4321,
      sdk: 'test',
    });
    expect(
      normalizeAgySdkBridgeMessage({ id: 'agy-sdk-1', ok: true, text: 'done', metadata: {} })
    ).toEqual({ id: 'agy-sdk-1', ok: true, text: 'done', metadata: {} });
  });

  it('rejects malformed bridge message shapes', () => {
    expect(normalizeAgySdkBridgeMessage(null)).toBeNull();
    expect(normalizeAgySdkBridgeMessage({})).toBeNull();
    expect(normalizeAgySdkBridgeMessage({ event: 'ready', pid: 0 })).toBeNull();
    expect(normalizeAgySdkBridgeMessage({ id: 'x', ok: 'true' })).toBeNull();
    expect(normalizeAgySdkBridgeMessage({ id: 'x', metadata: [] })).toBeNull();
    expect(normalizeAgySdkBridgeMessage({ id: 'x', text: 7 })).toBeNull();
  });

  it('boots the provider bridge and returns observed native-subagent metadata', async () => {
    let seenRequest: Record<string, unknown> | undefined;
    const spawnProcess = vi.fn(() =>
      fakeBridge((request) => {
        seenRequest = request;
        return {
          id: request.id,
          ok: true,
          text: 'delegated result',
          stopReason: 'completed',
          metadata: {
            nativeSubagent: {
              provider: 'agy',
              mode: 'antigravity-sdk',
              threadId: 'child-1',
            },
          },
        };
      })
    ) as any;
    adapter = new AgySdkAdapter({ spawnProcess, cwd: '/workspace', timeoutMs: 1000 });

    await adapter.boot();
    const response = await adapter.askNativeSubagent('inspect this', {
      profile: 'explorer',
      effort: 'medium',
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      expect.stringMatching(/(?:agy-sdk\/bin\/python|python3)$/u),
      [expect.stringContaining('scripts/agy_sdk_subagent_bridge.py')],
      expect.objectContaining({ cwd: '/workspace', stdio: 'pipe' })
    );
    expect(response.text).toBe('delegated result');
    expect(response.metadata?.nativeSubagent).toMatchObject({
      provider: 'agy',
      mode: 'antigravity-sdk',
      threadId: 'child-1',
    });
    expect(seenRequest).toMatchObject({ op: 'ask', profile: 'explorer', effort: 'medium' });
  });

  it('surfaces bridge errors as subagent-unavailable failures', async () => {
    const spawnProcess = vi.fn(() =>
      fakeBridge((request) => ({
        id: request.id,
        ok: false,
        error: '[SUBAGENT_UNAVAILABLE] SDK package missing',
      }))
    ) as any;
    adapter = new AgySdkAdapter({ spawnProcess, timeoutMs: 1000 });

    await expect(adapter.askNativeSubagent('inspect this')).rejects.toThrow(
      '[SUBAGENT_UNAVAILABLE] SDK package missing'
    );
  });

  it('sends cancellation through the bridge when the caller aborts', async () => {
    let cancellationSeen = false;
    const spawnProcess = vi.fn(() =>
      fakeBridge((request) => {
        if (request.op === 'cancel') {
          cancellationSeen = true;
          return { id: request.id, ok: true, cancelled: true };
        }
        return {
          id: request.id,
          ok: true,
          text: 'late result',
          stopReason: 'completed',
          __delayMs: 50,
        };
      })
    ) as any;
    adapter = new AgySdkAdapter({ spawnProcess, timeoutMs: 1000 });
    const controller = new AbortController();
    await adapter.boot();
    const request = adapter.askNativeSubagent('long task', { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(request).rejects.toThrow('[SUBAGENT_UNAVAILABLE] AGY SDK request aborted.');
    expect(cancellationSeen).toBe(true);
  });
});
