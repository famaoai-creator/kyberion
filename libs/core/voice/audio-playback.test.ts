import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  // Default to the real spawn so the subprocess-based tests below are
  // unaffected; pause/resume tests below override it per-call with a fake.
  spawnMock.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnMock };
});

import { playAudioFile, probeAudioPlayback } from './audio-playback.js';

interface FakeChild extends EventEmitter {
  stdout: null;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = null;
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = vi.fn(() => child.exitCode === null);
  return child;
}

function closeFakeChild(child: FakeChild, code = 0): void {
  child.exitCode = code;
  child.emit('close', code);
}

afterEach(() => {
  spawnMock.mockClear();
});

describe('audio playback', () => {
  it('reports a custom command as available', () => {
    expect(probeAudioPlayback({ command: ['true'] }).available).toBe(true);
  });

  it('resolves ok for a successful player process', async () => {
    const handle = playAudioFile('/tmp/whatever.wav', {
      command: [process.execPath, '-e', 'setTimeout(()=>process.exit(0),50)'],
    });
    const result = await handle.done;
    expect(result).toEqual({ ok: true, interrupted: false });
  });

  it('stop() interrupts a long-running player immediately', async () => {
    const handle = playAudioFile('/tmp/whatever.wav', {
      command: [process.execPath, '-e', 'setTimeout(()=>process.exit(0),60000)'],
    });
    const startedAt = Date.now();
    const result = await handle.stop();
    expect(result.interrupted).toBe(true);
    expect(result.ok).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it('reports player failure with the exit detail', async () => {
    const handle = playAudioFile('/tmp/whatever.wav', {
      command: [process.execPath, '-e', 'console.error("boom");process.exit(3)'],
    });
    const result = await handle.done;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/code 3/);
    expect(result.error).toMatch(/boom/);
  });

  it('substitutes the {file} placeholder in custom commands', async () => {
    const handle = playAudioFile('/tmp/target.wav', {
      command: [
        process.execPath,
        '-e',
        'process.exit(process.argv[1] === "/tmp/target.wav" ? 0 : 9)',
        '{file}',
      ],
    });
    const result = await handle.done;
    expect(result.ok).toBe(true);
  });

  describe('pause/resume (POSIX signal control)', () => {
    it('pause() sends SIGSTOP to the player process', () => {
      const child = createFakeChild();
      spawnMock.mockImplementationOnce(() => child);
      const handle = playAudioFile('/tmp/whatever.wav', { command: ['afplay'] });

      handle.pause?.();

      expect(child.kill).toHaveBeenCalledWith('SIGSTOP');
    });

    it('resume() sends SIGCONT after pause()', () => {
      const child = createFakeChild();
      spawnMock.mockImplementationOnce(() => child);
      const handle = playAudioFile('/tmp/whatever.wav', { command: ['afplay'] });

      handle.pause?.();
      handle.resume?.();

      expect(child.kill).toHaveBeenLastCalledWith('SIGCONT');
    });

    it('stop() while paused sends SIGCONT before the termination signal', async () => {
      const child = createFakeChild();
      spawnMock.mockImplementationOnce(() => child);
      const handle = playAudioFile('/tmp/whatever.wav', { command: ['afplay'] });

      handle.pause?.();
      const stopPromise = handle.stop();
      closeFakeChild(child, 0);
      const result = await stopPromise;

      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual([
        'SIGSTOP',
        'SIGCONT',
        'SIGTERM',
      ]);
      expect(result.interrupted).toBe(true);
    });

    it('pause()/resume() no-op once the process has already exited', async () => {
      const child = createFakeChild();
      spawnMock.mockImplementationOnce(() => child);
      const handle = playAudioFile('/tmp/whatever.wav', { command: ['afplay'] });

      closeFakeChild(child, 0);
      await handle.done;
      handle.pause?.();
      handle.resume?.();

      expect(child.kill).not.toHaveBeenCalled();
    });

    it('pause() reports false when SIGSTOP cannot be delivered (S11)', () => {
      const child = createFakeChild();
      child.kill = vi.fn((signal: NodeJS.Signals) => signal !== 'SIGSTOP');
      spawnMock.mockImplementationOnce(() => child);
      const handle = playAudioFile('/tmp/whatever.wav', { command: ['afplay'] });

      expect(handle.pause?.()).toBe(false);
    });

    it('pause() reports true on success and while already paused (S11)', () => {
      const child = createFakeChild();
      spawnMock.mockImplementationOnce(() => child);
      const handle = playAudioFile('/tmp/whatever.wav', { command: ['afplay'] });

      expect(handle.pause?.()).toBe(true);
      expect(handle.pause?.()).toBe(true);
    });

    it('SIGCONTs and kills a paused child on process exit (S11)', () => {
      const child = createFakeChild();
      spawnMock.mockImplementationOnce(() => child);
      const onSpy = vi.spyOn(process, 'on');
      const offSpy = vi.spyOn(process, 'off');
      try {
        const handle = playAudioFile('/tmp/whatever.wav', { command: ['afplay'] });

        expect(onSpy).not.toHaveBeenCalledWith('exit', expect.any(Function));
        handle.pause?.();
        expect(onSpy).toHaveBeenCalledWith('exit', expect.any(Function));
        const exitHandler = onSpy.mock.calls.find(([event]) => event === 'exit')?.[1] as (
          ...args: unknown[]
        ) => void;

        child.kill.mockClear();
        exitHandler();
        expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGCONT', 'SIGKILL']);

        // Cleanup removes the hook once the player is done, so a long-lived
        // host process doesn't accumulate one listener per playback.
        closeFakeChild(child, 0);
        expect(offSpy).toHaveBeenCalledWith('exit', exitHandler);
      } finally {
        onSpy.mockRestore();
        offSpy.mockRestore();
      }
    });

    it('does not expose pause/resume on win32', () => {
      const child = createFakeChild();
      spawnMock.mockImplementationOnce(() => child);
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });

      try {
        const handle = playAudioFile('/tmp/whatever.wav', { command: ['powershell.exe'] });
        expect(handle.pause).toBeUndefined();
        expect(handle.resume).toBeUndefined();
      } finally {
        Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
      }
    });
  });
});
