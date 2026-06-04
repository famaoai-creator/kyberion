import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const spawn = vi.fn();
  return { spawn };
});

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}));

describe('listenNativeSpeech', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createFakeChild() {
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    fakeChild.kill = vi.fn();
    return fakeChild;
  }

  it('spawns the native speech script and parses its result', async () => {
    const fakeChild = createFakeChild();
    mocks.spawn.mockReturnValue(fakeChild);

    const { listenNativeSpeech } = await import('./native-speech-listen-bridge.js');
    const promise = listenNativeSpeech({
      locale: 'ja-JP',
      timeoutSeconds: 8,
      deviceId: 'device-1',
      cwd: '/tmp/voice-hub',
    });

    fakeChild.stdout.emit(
      'data',
      JSON.stringify({
        ok: true,
        text: 'こんにちは',
        locale: 'ja-JP',
        isFinal: true,
        deviceId: 'device-1',
      }),
    );
    fakeChild.emit('close', 0);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.text).toBe('こんにちは');
    expect(result.locale).toBe('ja-JP');
    expect(result.deviceId).toBe('device-1');
    expect(mocks.spawn).toHaveBeenCalledWith(
      'swift',
      expect.arrayContaining([
        expect.stringContaining('satellites/voice-hub/native-stt.swift'),
        '--locale',
        'ja-JP',
        '--timeout',
        '8',
        '--device-id',
        'device-1',
      ]),
      expect.objectContaining({
        cwd: '/tmp/voice-hub',
      }),
    );
  });

  it('rejects if the swift script outputs invalid json', async () => {
    const fakeChild = createFakeChild();
    mocks.spawn.mockReturnValue(fakeChild);

    const { listenNativeSpeech } = await import('./native-speech-listen-bridge.js');
    const promise = listenNativeSpeech({
      locale: 'en-US',
      timeoutSeconds: 5,
    });

    fakeChild.stdout.emit('data', 'invalid raw stdout output');
    fakeChild.emit('close', 0);

    await expect(promise).rejects.toThrow('native_speech_invalid_json');
  });

  it('rejects with stderr if stdout is empty and close code is non-zero', async () => {
    const fakeChild = createFakeChild();
    mocks.spawn.mockReturnValue(fakeChild);

    const { listenNativeSpeech } = await import('./native-speech-listen-bridge.js');
    const promise = listenNativeSpeech({
      locale: 'en-US',
      timeoutSeconds: 5,
    });

    fakeChild.stderr.emit('data', 'something went wrong in swift stt');
    fakeChild.emit('close', 1);

    await expect(promise).rejects.toThrow('something went wrong in swift stt');
  });

  it('rejects on child process error and attempts to kill child process', async () => {
    const fakeChild = createFakeChild();
    mocks.spawn.mockReturnValue(fakeChild);

    const { listenNativeSpeech } = await import('./native-speech-listen-bridge.js');
    const promise = listenNativeSpeech({
      locale: 'en-US',
      timeoutSeconds: 5,
    });

    const assertionPromise = expect(promise).rejects.toThrow('Spawn failed');

    const errorObj = new Error('Spawn failed');
    fakeChild.emit('error', errorObj);

    await assertionPromise;
    expect(fakeChild.kill).toHaveBeenCalled();
  });

  it('enforces a safety timeout, kills process with SIGKILL, and rejects', async () => {
    const fakeChild = createFakeChild();
    mocks.spawn.mockReturnValue(fakeChild);

    const { listenNativeSpeech } = await import('./native-speech-listen-bridge.js');
    const promise = listenNativeSpeech({
      locale: 'en-US',
      timeoutSeconds: 5,
    });

    const assertionPromise = expect(promise).rejects.toThrow('native_speech_timeout');

    // Swift timeout is 5s, Node timeout is 5s * 1000 + 2000 = 7000ms.
    // Advance timers by 7100ms.
    await vi.advanceTimersByTimeAsync(7100);

    await assertionPromise;
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

