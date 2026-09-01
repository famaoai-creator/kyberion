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
import { abortableAudioChunks } from './meeting-session-types.js';
import type { AudioBus } from './audio-bus.js';
import { coreSeamCatalog, createSeam } from './seam.js';

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

const ALLOWED_MEETING_HOSTS: Record<'meet' | 'zoom' | 'teams', readonly string[]> = {
  meet: ['meet.google.com'],
  zoom: ['zoom.us', 'zoom.com'],
  teams: ['teams.microsoft.com', 'teams.live.com', 'microsoft.com'],
};

function normalizedMeetingHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return null;
    return parsed.hostname.replace(/\.+$/u, '').toLowerCase();
  } catch {
    return null;
  }
}

function hostMatches(host: string, allowed: string): boolean {
  return host === allowed || host.endsWith(`.${allowed}`);
}

export function redactMeetingUrl(url: string | undefined): string {
  if (!url) return 'missing-url';
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

export function resolveMeetingPlatformFromUrl(url: string): 'meet' | 'zoom' | 'teams' | null {
  try {
    const parsed = new URL(url);
    const host = normalizedMeetingHost(url);
    if (!host) return null;
    const pathname = parsed.pathname.toLowerCase();
    if (hostMatches(host, 'meet.google.com')) return 'meet';
    if (hostMatches(host, 'zoom.us') || hostMatches(host, 'zoom.com')) return 'zoom';
    if (hostMatches(host, 'teams.microsoft.com') || hostMatches(host, 'teams.live.com'))
      return 'teams';
    if (hostMatches(host, 'microsoft.com') && pathname.includes('/microsoft-teams/join-a-meeting'))
      return 'teams';
  } catch {
    /* fall through */
  }
  return null;
}

export function resolveMeetingPlatform(
  target: MeetingTarget
): 'meet' | 'zoom' | 'teams' | 'in_room' {
  if (target.platform !== 'auto') return target.platform;
  const inferred = resolveMeetingPlatformFromUrl(target.url);
  if (!inferred) {
    throw new Error(
      `[browser-driver] unsupported meeting URL for auto platform detection: ${redactMeetingUrl(target.url)}; pass --platform explicitly`
    );
  }
  return inferred;
}

export function validateMeetingTarget(
  target: MeetingTarget
): MeetingTarget & { platform: 'meet' | 'zoom' | 'teams' | 'in_room' } {
  const platform = resolveMeetingPlatform(target);
  // 同席モード: the meeting happens in the physical room — there is no URL
  // host to allow-list. Accept the sentinel room:// URL as-is.
  if (platform === 'in_room') {
    return { ...target, platform, url: target.url || 'room://local' };
  }
  const host = normalizedMeetingHost(target.url);
  if (!host || host === 'invalid-url' || host === 'missing-url') {
    throw new Error(`[browser-driver] invalid meeting URL host: ${redactMeetingUrl(target.url)}`);
  }
  const allowlist = ALLOWED_MEETING_HOSTS[platform];
  if (!allowlist.some((allowed) => hostMatches(host, allowed))) {
    throw new Error(
      `[browser-driver] meeting URL host '${host}' is not allow-listed for platform '${platform}'. Allowed hosts: ${allowlist.join(', ')}.`
    );
  }
  if (platform === 'teams' && host === 'microsoft.com') {
    const pathname = new URL(target.url).pathname.toLowerCase();
    if (!pathname.includes('/microsoft-teams/join-a-meeting')) {
      throw new Error(
        `[browser-driver] Teams on microsoft.com must use the join-a-meeting entry page; got path '${pathname}'.`
      );
    }
  }
  return { ...target, platform };
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

const meetingJoinDriverSeam = createSeam<MeetingJoinDriver>({
  key: 'meeting-join-driver',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});
const meetingJoinDriverDisposers = new Map<string, () => void>();

export function registerMeetingJoinDriver(driver: MeetingJoinDriver): () => void {
  const seamDispose = meetingJoinDriverSeam.register(driver.driver_id, driver, {
    provenance: 'builtin',
    source: 'meeting-join-driver',
  });
  const dispose = () => {
    seamDispose();
    if (meetingJoinDriverDisposers.get(driver.driver_id) === dispose) {
      meetingJoinDriverDisposers.delete(driver.driver_id);
    }
  };
  meetingJoinDriverDisposers.set(driver.driver_id, dispose);
  return dispose;
}

export function getMeetingJoinDriver(driver_id: string): MeetingJoinDriver | undefined {
  return meetingJoinDriverSeam.getOptional(driver_id);
}

/**
 * Return all registered drivers that claim `platform`. Useful when
 * the coordinator wants to fall back: try `zoom-sdk` first, fall to
 * `browser-playwright`, fall to `stub`.
 */
export function listMeetingJoinDriversFor(platform: MeetingPlatform): MeetingJoinDriver[] {
  return meetingJoinDriverSeam
    .list()
    .map(({ implementation }) => implementation)
    .filter(
      (d) => d.supported_platforms.includes(platform) || d.supported_platforms.includes('auto')
    );
}

export function resetMeetingJoinDriverRegistry(): void {
  for (const dispose of [...meetingJoinDriverDisposers.values()]) dispose();
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
      async audioOutput(stream: AsyncIterable<AudioChunk>, signal?: AbortSignal): Promise<void> {
        await bus.writeOutput(abortableAudioChunks(stream, signal));
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
