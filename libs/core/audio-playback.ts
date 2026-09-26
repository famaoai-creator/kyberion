/* eslint-disable no-restricted-imports */
/**
 * Local audio playback with an interruptible handle.
 *
 * The realtime voice loop needs to *stop* assistant speech the moment
 * the user barges in, so playback cannot stay buried inside the voice
 * actuator process. This module plays an audio file via the platform
 * player (afplay on macOS, aplay on Linux) and exposes a PlaybackHandle
 * whose `stop()` kills the player process immediately.
 *
 * Tests inject `command` to replay deterministic behavior without audio
 * hardware (same pattern as mic-capture).
 */

import { spawn, spawnSync } from 'node:child_process';

export interface PlaybackHandle {
  /** Resolves when playback finishes or is stopped. Never rejects. */
  done: Promise<PlaybackResult>;
  /** Stop playback immediately (SIGTERM, then SIGKILL after 1.5s). Idempotent. */
  stop(): Promise<PlaybackResult>;
  /**
   * Suspend the player in place (SIGSTOP on POSIX) so resume() continues the
   * same segment instead of restarting it. Present only when the platform
   * supports it (POSIX); absent on win32, where callers fall back to
   * stop-and-replay.
   *
   * Returns true when the process is now suspended (including if it already
   * was), false when SIGSTOP could not be delivered — callers must not
   * assume silence and should fall back to stop-and-replay in that case.
   *
   * SIGSTOP is delivered to the spawned child process only. A custom
   * `command` that wraps the real player in a shell (e.g. `sh -c '...'`)
   * suspends the shell, not any grandchild it spawned, so audio can keep
   * playing — pause() reports success (the shell stopped) even though
   * sound is not actually silenced in that case.
   */
  pause?(): boolean;
  /** Resume a player suspended by pause() (SIGCONT on POSIX). */
  resume?(): void;
}

export interface PlaybackResult {
  ok: boolean;
  /** True when stop() ended the playback early. */
  interrupted: boolean;
  error?: string;
}

export interface PlayAudioOptions {
  /** Full argv override; audio path is appended unless `{file}` placeholder is used. */
  command?: string[];
}

export interface AudioPlaybackProbeResult {
  available: boolean;
  backend: 'afplay' | 'aplay' | 'powershell-soundplayer' | 'custom' | 'none';
  reason?: string;
}

interface AudioPlaybackAdapter {
  backend: 'afplay' | 'aplay' | 'powershell-soundplayer';
  command(audioPath: string): string[];
  probe(): boolean;
}
const audioAdapters: Partial<Record<NodeJS.Platform, AudioPlaybackAdapter>> = {
  darwin: {
    backend: 'afplay',
    command: (file) => ['afplay', file],
    probe: () => spawnSync('which', ['afplay'], { stdio: 'ignore' }).status === 0,
  },
  linux: {
    backend: 'aplay',
    command: (file) => ['aplay', '-q', file],
    probe: () => spawnSync('which', ['aplay'], { stdio: 'ignore' }).status === 0,
  },
  win32: {
    backend: 'powershell-soundplayer',
    command: (file) => [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(New-Object System.Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`,
    ],
    probe: () => spawnSync('where', ['powershell.exe'], { stdio: 'ignore' }).status === 0,
  },
};
function resolveAudioPlaybackAdapter(): AudioPlaybackAdapter | undefined {
  return audioAdapters[process.platform];
}

export function probeAudioPlayback(opts: PlayAudioOptions = {}): AudioPlaybackProbeResult {
  if (opts.command?.length) return { available: true, backend: 'custom' };
  const adapter = resolveAudioPlaybackAdapter();
  const binary =
    adapter?.backend === 'afplay'
      ? 'afplay'
      : adapter?.backend === 'aplay'
        ? 'aplay'
        : 'powershell.exe';
  const probe = adapter
    ? { error: undefined, status: adapter.probe() ? 0 : 1 }
    : { error: new Error('unsupported'), status: 1 };
  if (probe.error || probe.status !== 0) {
    return {
      available: false,
      backend: 'none',
      reason: `${binary} is not available on PATH — local playback is disabled`,
    };
  }
  return { available: true, backend: adapter!.backend };
}

function buildArgv(audioPath: string, opts: PlayAudioOptions): string[] {
  if (opts.command?.length) {
    const argv = opts.command.map((part) => (part === '{file}' ? audioPath : part));
    return argv.includes(audioPath) ? argv : [...argv, audioPath];
  }
  const adapter = resolveAudioPlaybackAdapter();
  if (!adapter) throw new Error(`audio playback is unsupported on ${process.platform}`);
  return adapter.command(audioPath);
}

/** Resolve the native playback command for callers that stream their own audio. */
export function resolveAudioPlaybackCommand(audioPath = '{file}'): string[] | null {
  const adapter = resolveAudioPlaybackAdapter();
  return adapter ? adapter.command(audioPath) : null;
}

/** True when `handle` exposes in-place pause()/resume() (see PlaybackHandle). */
export function isPausablePlaybackHandle(
  handle: PlaybackHandle
): handle is PlaybackHandle & { pause(): boolean; resume(): void } {
  return typeof handle.pause === 'function' && typeof handle.resume === 'function';
}

export function playAudioFile(audioPath: string, opts: PlayAudioOptions = {}): PlaybackHandle {
  const argv = buildArgv(audioPath, opts);
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] });

  let settled = false;
  let interrupted = false;
  let paused = false;
  let stderrTail = '';
  child.stderr?.on('data', (data: Buffer) => {
    stderrTail = `${stderrTail}${data.toString()}`.slice(-1000);
  });

  let resolveDone: (result: PlaybackResult) => void = () => undefined;
  const done = new Promise<PlaybackResult>((resolve) => {
    resolveDone = resolve;
  });

  // Best-effort: registered only once a pause actually suspends the child, so
  // a host process exiting while playback is stopped doesn't leave the
  // player permanently stuck (it would otherwise never see SIGTERM/SIGKILL
  // dispatched after node has already begun tearing down).
  let exitHookInstalled = false;
  const exitHook = (): void => {
    if (!paused) return;
    sendSignal('SIGCONT');
    sendSignal('SIGKILL');
  };

  const settle = (result: PlaybackResult): void => {
    if (settled) return;
    settled = true;
    if (exitHookInstalled) process.off('exit', exitHook);
    resolveDone(result);
  };

  child.on('error', (error) => {
    settle({ ok: false, interrupted, error: error.message });
  });
  child.on('close', (code) => {
    if (interrupted) {
      settle({ ok: true, interrupted: true });
      return;
    }
    settle(
      code === 0
        ? { ok: true, interrupted: false }
        : {
            ok: false,
            interrupted: false,
            error: `${argv[0]} exited with code ${code}${stderrTail ? `: ${stderrTail.trim()}` : ''}`,
          }
    );
  });

  /** Send a POSIX signal to the player; false/caught when it can't be delivered (already gone). */
  const sendSignal = (signal: NodeJS.Signals): boolean => {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  };

  const handle: PlaybackHandle = {
    done,
    stop: async () => {
      if (!settled) {
        interrupted = true;
        // A suspended (SIGSTOPped) process never sees SIGTERM, so resume it
        // first — otherwise it can't exit and stop() would hang until SIGKILL.
        if (paused) {
          sendSignal('SIGCONT');
          paused = false;
        }
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, 1500);
        await done;
        clearTimeout(killTimer);
      }
      return done;
    },
  };

  // Pause-in-place is a POSIX signal trick (SIGSTOP/SIGCONT); win32 has no
  // equivalent, so callers keep the stop-and-replay fallback there.
  if (process.platform !== 'win32') {
    handle.pause = () => {
      if (settled) return false;
      if (paused) return true;
      if (!sendSignal('SIGSTOP')) return false;
      paused = true;
      if (!exitHookInstalled) {
        exitHookInstalled = true;
        process.on('exit', exitHook);
      }
      return true;
    };
    handle.resume = () => {
      if (settled || !paused) return;
      sendSignal('SIGCONT');
      paused = false;
    };
  }

  return handle;
}
