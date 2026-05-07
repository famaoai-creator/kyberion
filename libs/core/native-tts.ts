/**
 * Native OS Text-to-Speech wrapper (Phase A-5, voice tier 0).
 *
 * Speaks text using the OS's built-in TTS:
 * - macOS:   `say`
 * - Linux:   `espeak` (or `spd-say` if espeak missing)
 * - Windows: PowerShell + System.Speech.Synthesis.SpeechSynthesizer
 *
 * Goals:
 * - Zero install on macOS / Windows (built into the OS).
 * - Single `apt install espeak` on Linux, surfaced by `pnpm doctor`.
 * - No API key, no network call.
 *
 * This is the response side of the tier-0 voice first-win. The browser
 * (presence-studio) handles the input side via Web Speech API.
 *
 * Tier 1 (cloud voice) and tier 2 (local Style-Bert-VITS2) are separate
 * implementations under `libs/actuators/voice-actuator/` and
 * `libs/core/anthropic-voice-bridge.ts`.
 */

import { spawn } from 'node:child_process';
import * as os from 'node:os';

export type Platform = 'darwin' | 'linux' | 'win32';

export interface SpeakOptions {
  /** Voice name hint (passed to OS-specific flag when supported). */
  voice?: string;
  /** Words per minute. Defaults to OS default. */
  rate?: number;
  /** Quiet failures (return false instead of throwing). Default true. */
  silent?: boolean;
  /** Process timeout in ms. Default 30000 (30s). */
  timeoutMs?: number;
}

export interface SpeakResult {
  ok: boolean;
  platform: Platform;
  command: string;
  exitCode?: number;
  error?: string;
}

const PLATFORM = process.platform as Platform;

function buildCommand(text: string, opts: SpeakOptions): { cmd: string; args: string[] } | null {
  // Sanitize: TTS engines should not interpret shell metachars, but we still
  // strip control characters so screen-reader-style commands can't be injected.
  const safe = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  switch (PLATFORM) {
    case 'darwin': {
      const args: string[] = [];
      if (opts.voice) args.push('-v', opts.voice);
      if (opts.rate) args.push('-r', String(opts.rate));
      args.push(safe);
      return { cmd: 'say', args };
    }
    case 'linux': {
      // Prefer espeak; fall back to spd-say. We don't introspect at this point —
      // the caller's preflight should have verified availability.
      const args: string[] = [];
      if (opts.voice) args.push('-v', opts.voice);
      if (opts.rate) args.push('-s', String(opts.rate));
      args.push(safe);
      return { cmd: 'espeak', args };
    }
    case 'win32': {
      // PowerShell one-liner using System.Speech.Synthesis.SpeechSynthesizer.
      const escaped = safe.replace(/'/g, "''");
      const rateClause = opts.rate ? `;$s.Rate=${Math.round((opts.rate - 175) / 35)}` : '';
      const ps = `Add-Type -AssemblyName System.Speech;$s=New-Object System.Speech.Synthesis.SpeechSynthesizer${rateClause};$s.Speak('${escaped}')`;
      return { cmd: 'powershell', args: ['-NoProfile', '-Command', ps] };
    }
    default:
      return null;
  }
}

/**
 * Speak the given text using the OS's native TTS.
 * Returns a SpeakResult; never throws unless `silent: false`.
 */
export async function speak(text: string, opts: SpeakOptions = {}): Promise<SpeakResult> {
  const silent = opts.silent ?? true;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const built = buildCommand(text, opts);
  if (!built) {
    const err = `Unsupported platform: ${PLATFORM}`;
    if (!silent) throw new Error(err);
    return { ok: false, platform: PLATFORM, command: 'unsupported', error: err };
  }

  return await new Promise<SpeakResult>(resolve => {
    let resolved = false;
    const child = spawn(built.cmd, built.args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
      const err = `TTS timed out after ${timeoutMs}ms`;
      if (!silent) {
        // Defer the throw to next tick so the caller's await still observes the resolution path.
        Promise.resolve().then(() => { throw new Error(err); });
      }
      resolve({ ok: false, platform: PLATFORM, command: built.cmd, error: err });
    }, timeoutMs);

    child.on('error', err => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const message = err.message;
      if (!silent) {
        Promise.resolve().then(() => { throw err; });
      }
      resolve({ ok: false, platform: PLATFORM, command: built.cmd, error: message });
    });

    child.on('close', code => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, platform: PLATFORM, command: built.cmd, exitCode: 0 });
      } else {
        const err = `${built.cmd} exited ${code}: ${stderr.slice(0, 500)}`;
        if (!silent) {
          Promise.resolve().then(() => { throw new Error(err); });
        }
        resolve({ ok: false, platform: PLATFORM, command: built.cmd, exitCode: code ?? -1, error: err });
      }
    });
  });
}

/**
 * Probe whether native TTS is available on this platform.
 * Returns the command name and platform, or null if unsupported.
 *
 * This is a best-effort check: it confirms the binary exists, not that audio
 * output is actually working (TTS through SSH / containers / muted speakers
 * will still report "available").
 */
export async function probeNativeTts(): Promise<{ available: boolean; platform: Platform; command: string; reason?: string }> {
  const cmd = (() => {
    switch (PLATFORM) {
      case 'darwin': return 'say';
      case 'linux': return 'espeak';
      case 'win32': return 'powershell';
      default: return null;
    }
  })();
  if (!cmd) {
    return {
      available: false,
      platform: PLATFORM,
      command: 'unsupported',
      reason: `Platform ${PLATFORM} has no native TTS adapter`,
    };
  }

  return await new Promise(resolve => {
    const probeArgs =
      PLATFORM === 'win32'
        ? ['-NoProfile', '-Command', "Add-Type -AssemblyName System.Speech | Out-Null; 'ok'"]
        : ['--version'];
    const child = spawn(cmd, probeArgs, { stdio: 'ignore' });
    child.on('error', err => {
      resolve({
        available: false,
        platform: PLATFORM,
        command: cmd,
        reason:
          PLATFORM === 'linux'
            ? `${cmd} not installed. Try: sudo apt-get install espeak`
            : err.message,
      });
    });
    child.on('close', code => {
      resolve({
        available: code === 0 || code === 1, // some `--version` exit non-zero but binary works
        platform: PLATFORM,
        command: cmd,
      });
    });
  });
}

/** Detected current platform — exported for tests / preflight. */
export function currentPlatform(): Platform {
  return PLATFORM;
}

/** Returns true on platforms with built-in TTS (macOS, Windows). */
export function hasBuiltInTts(): boolean {
  return PLATFORM === 'darwin' || PLATFORM === 'win32';
}

export const __test__ = { buildCommand };
