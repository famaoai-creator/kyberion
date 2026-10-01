/**
 * Meeting platform registry (RS-06).
 *
 * `knowledge/product/governance/meeting-platforms.json` is the single source
 * for joinable meeting platforms: URL hosts (with optional entry-page path
 * restriction), provider-adapter aliases and the browser driver's UI
 * selectors. Callers resolve a descriptor here instead of branching on
 * `platform === 'teams'`. Unknown platforms fail closed.
 */
import { pathResolver } from '../path-resolver.js';
import { defineCatalog } from '../foundation/governed-catalog.js';

export type MeetingSelectorEntry = string | { selector: string; locale: string };

export interface MeetingPlatformHost {
  host: string;
  /** When set, a URL on this host must include this path (case-insensitive). */
  required_path?: string;
}

export interface MeetingPlatformDescriptor {
  id: string;
  display_name: string;
  provider_id: string;
  provider_aliases: string[];
  execution_provider: string;
  hosts: MeetingPlatformHost[];
  pre_join_selectors: Record<string, MeetingSelectorEntry[]>;
  in_meeting_selectors: Record<string, MeetingSelectorEntry[]>;
}

interface MeetingPlatformRegistryFile {
  version: string;
  default_selector_platform: string;
  platforms: Record<string, Omit<MeetingPlatformDescriptor, 'id'>>;
}

const meetingPlatformCatalog = defineCatalog<MeetingPlatformRegistryFile>({
  id: 'meeting-platforms',
  path: () => pathResolver.knowledge('product/governance/meeting-platforms.json'),
  schema: pathResolver.knowledge('product/schemas/meeting-platforms.schema.json'),
});

function loadRegistry(): MeetingPlatformRegistryFile {
  return meetingPlatformCatalog.load();
}

export function listMeetingPlatforms(): MeetingPlatformDescriptor[] {
  return Object.entries(loadRegistry().platforms).map(([id, entry]) => ({ id, ...entry }));
}

export function listMeetingPlatformIds(): string[] {
  return Object.keys(loadRegistry().platforms);
}

export function findMeetingPlatform(id: string): MeetingPlatformDescriptor | undefined {
  const entry = loadRegistry().platforms[id];
  return entry ? { id, ...entry } : undefined;
}

/** Resolve a registered platform; unknown ids fail closed with a reason. */
export function getMeetingPlatform(id: string): MeetingPlatformDescriptor {
  const descriptor = findMeetingPlatform(id);
  if (!descriptor) {
    throw new Error(
      `[meeting-platform-registry] unknown meeting platform "${id}" — register it in knowledge/product/governance/meeting-platforms.json`
    );
  }
  return descriptor;
}

/** Platform whose selectors apply when a platform id is unregistered (e.g. `auto`). */
export function defaultSelectorMeetingPlatform(): MeetingPlatformDescriptor {
  return getMeetingPlatform(loadRegistry().default_selector_platform);
}

/** Resolve a platform by provider id or alias (e.g. `google_meet`, `teams_pipeline`). */
export function findMeetingPlatformByProvider(
  provider: string
): MeetingPlatformDescriptor | undefined {
  return listMeetingPlatforms().find(
    (platform) => platform.provider_id === provider || platform.provider_aliases.includes(provider)
  );
}

export function meetingHostMatches(host: string, allowed: string): boolean {
  return host === allowed || host.endsWith(`.${allowed}`);
}

/**
 * The host entry of `platform` that decides `host` (first match in declared
 * order), or undefined when the host is not allow-listed for the platform.
 */
export function matchMeetingPlatformHost(
  platform: MeetingPlatformDescriptor,
  host: string
): MeetingPlatformHost | undefined {
  return platform.hosts.find((entry) => meetingHostMatches(host, entry.host));
}

/** True when the URL pathname satisfies the host entry's path restriction. */
export function meetingHostPathAllowed(entry: MeetingPlatformHost, pathname: string): boolean {
  return !entry.required_path || pathname.toLowerCase().includes(entry.required_path.toLowerCase());
}

/** Resolve a platform from a normalized host + pathname, or null. */
export function resolveMeetingPlatformByHost(
  host: string,
  pathname: string
): MeetingPlatformDescriptor | null {
  for (const platform of listMeetingPlatforms()) {
    const entry = matchMeetingPlatformHost(platform, host);
    if (entry && meetingHostPathAllowed(entry, pathname)) return platform;
  }
  return null;
}

export interface MeetingSelectorOptions {
  /** Restrict localized label selectors to these locales; neutral selectors always apply. */
  locales?: readonly string[];
}

/** Flatten a selector list to strings, preserving try-order. */
export function resolveMeetingSelectorList(
  entries: readonly MeetingSelectorEntry[],
  options: MeetingSelectorOptions = {}
): string[] {
  return entries.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (options.locales && !options.locales.includes(entry.locale)) return [];
    return [entry.selector];
  });
}

export function resolveMeetingSelectorGroup(
  group: Record<string, MeetingSelectorEntry[]>,
  options: MeetingSelectorOptions = {}
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(group).map(([key, entries]) => [
      key,
      resolveMeetingSelectorList(entries, options),
    ])
  );
}
