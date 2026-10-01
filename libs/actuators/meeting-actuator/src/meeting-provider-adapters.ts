import {
  findMeetingPlatformByProvider,
  listMeetingPlatforms,
  meetingHostMatches,
  type MeetingPlatformDescriptor,
} from '@agent/core/meeting/meeting-platform-registry';

export type MeetingProviderId = 'zoom' | 'teams' | 'google_meet';

export interface MeetingProviderAdapter {
  readonly id: MeetingProviderId;
  /** Registered meeting platform id (meeting-platforms.json). */
  readonly platform: string;
  /** Provider value the meeting actuator executes with (e.g. `teams_pipeline`). */
  readonly executionProvider: string;
  readonly hosts: readonly string[];
  matchesUrl(url: string): boolean;
  normalizeUrl(url: string): string;
}

/** One URL-based adapter per registry descriptor (RS-06): no per-provider classes. */
class RegistryMeetingProviderAdapter implements MeetingProviderAdapter {
  readonly id: MeetingProviderId;
  readonly platform: string;
  readonly executionProvider: string;
  readonly hosts: readonly string[];

  constructor(descriptor: MeetingPlatformDescriptor) {
    this.id = descriptor.provider_id as MeetingProviderId;
    this.platform = descriptor.id;
    this.executionProvider = descriptor.execution_provider;
    this.hosts = descriptor.hosts.map((entry) => entry.host);
  }

  matchesUrl(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return this.hosts.some((suffix) => meetingHostMatches(host, suffix));
    } catch {
      return false;
    }
  }

  normalizeUrl(url: string): string {
    return url.trim();
  }
}

export function listMeetingProviderAdapters(): MeetingProviderAdapter[] {
  return listMeetingPlatforms().map((descriptor) => new RegistryMeetingProviderAdapter(descriptor));
}

export function resolveMeetingProvider(
  provider: string | undefined,
  url: string | undefined
): MeetingProviderAdapter | undefined {
  const adapters = listMeetingProviderAdapters();
  if (provider && provider !== 'auto') {
    const descriptor = findMeetingPlatformByProvider(provider);
    const explicit = descriptor
      ? adapters.find((adapter) => adapter.platform === descriptor.id)
      : undefined;
    if (explicit) return explicit;
  }
  return url ? adapters.find((adapter) => adapter.matchesUrl(url)) : undefined;
}
