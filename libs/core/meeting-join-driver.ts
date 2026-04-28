/**
 * MeetingJoinDriver — the layer that knows how to actually walk
 * through a meeting platform's pre-join UI (browser automation /
 * vendor SDK / 3rd-party bot service) and hand back a `MeetingSession`.
 *
 * Why a registry instead of `if (platform === 'meet') ...`: we want
 * to ship the abstractions before any one concrete driver is final.
 * Drivers register themselves at module load (`browser-playwright`,
 * `zoom-sdk`, `recall-ai`, `stub`) and the coordinator picks one by
 * `(platform, driver_id)` pair.
 */

import type {
  MeetingPlatform,
  MeetingSession,
  MeetingSessionState,
  MeetingTarget,
  AudioChunk,
} from './meeting-session-types.js';
import type { AudioBus } from './audio-bus.js';

export interface MeetingJoinDriver {
  readonly driver_id: string;
  /** Platforms this driver can handle (a driver may serve multiple). */
  readonly supported_platforms: readonly MeetingPlatform[];
  /**
   * Capability probe. Returns `available=false` (with a reason) when
   * the host environment can't satisfy this driver — e.g., Playwright
   * not installed. Coordinator falls back to a different driver.
   */
  probe(): Promise<{ available: boolean; reason?: string }>;
  /**
   * Walk the pre-join UI / SDK handshake and return an open session.
   * Errors throw with a structured message; caller is responsible
   * for emitting the audit-chain entry.
   */
  join(target: MeetingTarget, bus: AudioBus): Promise<MeetingSession>;
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

const _drivers = new Map<string, MeetingJoinDriver>();

export function registerMeetingJoinDriver(driver: MeetingJoinDriver): void {
  _drivers.set(driver.driver_id, driver);
}

export function getMeetingJoinDriver(driver_id: string): MeetingJoinDriver | undefined {
  return _drivers.get(driver_id);
}

/**
 * Return all registered drivers that claim `platform`. Useful when
 * the coordinator wants to fall back: try `zoom-sdk` first, fall to
 * `browser-playwright`, fall to `stub`.
 */
export function listMeetingJoinDriversFor(platform: MeetingPlatform): MeetingJoinDriver[] {
  return Array.from(_drivers.values()).filter(
    (d) => d.supported_platforms.includes(platform) || d.supported_platforms.includes('auto'),
  );
}

export function resetMeetingJoinDriverRegistry(): void {
  _drivers.clear();
}

/* ------------------------------------------------------------------ *
 * StubMeetingJoinDriver — works against a `StubAudioBus`. Used in
 * tests + the autonomous fallback when no other driver is available.
 * The session's audio I/O passes through the bus so the coordinator's
 * agent loop can run end-to-end with no hardware.
 * ------------------------------------------------------------------ */

export class StubMeetingJoinDriver implements MeetingJoinDriver {
  readonly driver_id = 'stub';
  readonly supported_platforms = ['zoom', 'teams', 'meet', 'auto'] as const;

  async probe(): Promise<{ available: boolean }> {
    return { available: true };
  }

  async join(target: MeetingTarget, bus: AudioBus): Promise<MeetingSession> {
    const state: MeetingSessionState = {
      session_id: `stub-${Date.now()}`,
      platform: target.platform === 'auto' ? 'meet' : target.platform,
      status: 'in_meeting',
      joined_at: new Date().toISOString(),
    };
    let leftSignaled = false;
    return {
      state,
      async *audioInput(): AsyncIterable<AudioChunk> {
        for await (const chunk of bus.inputStream()) {
          if (leftSignaled) return;
          yield chunk;
        }
      },
      async audioOutput(stream: AsyncIterable<AudioChunk>): Promise<void> {
        await bus.writeOutput(stream);
      },
      async chat(_text: string): Promise<void> {
        /* no-op */
      },
      async leave(): Promise<void> {
        leftSignaled = true;
        state.status = 'ended';
        state.left_at = new Date().toISOString();
        await bus.close();
      },
    };
  }
}

// Pre-register the stub so a fresh import always has at least one driver.
registerMeetingJoinDriver(new StubMeetingJoinDriver());
