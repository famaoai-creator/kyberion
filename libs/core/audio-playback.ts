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

export function playAudioFile(audioPath: string, opts: PlayAudioOptions = {}): PlaybackHandle {
  const argv = buildArgv(audioPath, opts);
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] });

  let settled = false;
  let interrupted = false;
  let stderrTail = '';
  child.stderr?.on('data', (data: Buffer) => {
    stderrTail = `${stderrTail}${data.toString()}`.slice(-1000);
  });

  let resolveDone: (result: PlaybackResult) => void = () => undefined;
  const done = new Promise<PlaybackResult>((resolve) => {
    resolveDone = resolve;
  });

  const settle = (result: PlaybackResult): void => {
    if (settled) return;
    settled = true;
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

  return {
    done,
    stop: async () => {
      if (!settled) {
        interrupted = true;
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
}
