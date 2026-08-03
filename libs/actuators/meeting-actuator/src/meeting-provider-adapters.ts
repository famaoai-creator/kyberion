export type MeetingProviderId = 'zoom' | 'teams' | 'google_meet';

export interface MeetingProviderAdapter {
  readonly id: MeetingProviderId;
  readonly hosts: readonly string[];
  matchesUrl(url: string): boolean;
  normalizeUrl(url: string): string;
}

abstract class UrlMeetingProviderAdapter implements MeetingProviderAdapter {
  abstract readonly id: MeetingProviderId;
  abstract readonly hosts: readonly string[];

  matchesUrl(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return this.hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    } catch {
      return false;
    }
  }

  normalizeUrl(url: string): string {
    return url.trim();
  }
}

export class ZoomMeetingProviderAdapter extends UrlMeetingProviderAdapter {
  readonly id = 'zoom' as const;
  readonly hosts = ['zoom.us', 'zoom.com', 'app.zoom.us'] as const;
}

export class TeamsMeetingProviderAdapter extends UrlMeetingProviderAdapter {
  readonly id = 'teams' as const;
  readonly hosts = ['teams.microsoft.com', 'teams.live.com', 'microsoft.com'] as const;
}

export class GoogleMeetProviderAdapter extends UrlMeetingProviderAdapter {
  readonly id = 'google_meet' as const;
  readonly hosts = ['meet.google.com'] as const;
}

export const MEETING_PROVIDER_ADAPTERS: readonly MeetingProviderAdapter[] = [
  new ZoomMeetingProviderAdapter(),
  new TeamsMeetingProviderAdapter(),
  new GoogleMeetProviderAdapter(),
];

export function resolveMeetingProvider(
  provider: string | undefined,
  url: string | undefined
): MeetingProviderAdapter | undefined {
  const explicit =
    provider && provider !== 'auto'
      ? MEETING_PROVIDER_ADAPTERS.find((adapter) => {
          if (provider === 'meet' || provider === 'google_meet')
            return adapter.id === 'google_meet';
          if (provider === 'teams' || provider === 'teams_pipeline') return adapter.id === 'teams';
          return adapter.id === provider;
        })
      : undefined;
  if (explicit) return explicit;
  return url ? MEETING_PROVIDER_ADAPTERS.find((adapter) => adapter.matchesUrl(url)) : undefined;
}
