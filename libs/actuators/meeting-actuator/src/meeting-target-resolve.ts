/**
 * Calendar → meeting-join target resolution.
 *
 * Calendar events carry meeting links in `location` or `description`
 * (host-dependent, never a dedicated field). This module extracts the
 * first Meet / Zoom / Teams URL and picks the single event the watcher
 * should join now. Pure functions only — no IO, no clock beyond an
 * injectable `now`.
 */

import { resolveMeetingPlatformByHost } from '@agent/core/meeting/meeting-platform-registry';
import { stripTags } from '@agent/core/html-sanitize';
import { decodeEntities } from '@agent/core/text-escaping';

export type JoinablePlatform = 'meet' | 'zoom' | 'teams';

export interface CalendarLikeEvent {
  title?: string;
  start?: string;
  end?: string;
  location?: string;
  description?: string;
  /** Recurring-series id from the calendar provider (standing-grant match). */
  series_id?: string;
  /** Provider conference link (e.g. Google Meet `hangoutLink`). */
  meeting_url?: string;
}

export interface ResolvedMeetingTarget {
  found: boolean;
  title?: string;
  url?: string;
  platform?: JoinablePlatform;
  /** Calendar series id of the event, when it recurs. */
  series_id?: string;
  start?: string;
  end?: string;
  /** Seconds from now until start (negative = already started). */
  starts_in_sec?: number;
  /** How long the watcher should stay (clamped). */
  join_duration_sec?: number;
  /** Filesystem-safe stamp for transcript artifacts. */
  file_slug?: string;
  reason?: string;
}

export interface ResolveNextTargetOptions {
  /** ISO instant or epoch ms. Defaults to Date.now(). */
  now?: string | number;
  /** Join meetings that started at most this many minutes ago. Default 5. */
  started_ago_min?: number;
  /** Join meetings starting within this many minutes. Default 10. */
  starts_within_min?: number;
  /** Upper bound for the join duration. Default 5400 (90 min). */
  max_duration_sec?: number;
}

const URL_PATTERN = /https?:\/\/[^\s"'<>)]+/giu;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function platformOf(url: string): JoinablePlatform | undefined {
  const host = hostOf(url);
  if (!host) return undefined;
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  // Hosts and entry-path restrictions (bare microsoft.com hosts many
  // non-meeting pages, so Teams requires its join path) are registry data.
  return (resolveMeetingPlatformByHost(host, pathname)?.id as JoinablePlatform) ?? undefined;
}

const TRAILING_URL_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?']);

// Linear trailing-punctuation trim (an anchored `[...]+$` regex backtracks
// quadratically on long punctuation runs).
function cleanUrl(raw: string): string {
  let end = raw.length;
  while (end > 0 && TRAILING_URL_PUNCTUATION.has(raw[end - 1])) end -= 1;
  return raw.slice(0, end);
}

function stripMarkup(text: string): string {
  return decodeEntities(stripTags(text));
}

/** First known meeting URL in `meeting_url`, then `location`, then `description`. */
export function extractMeetingUrl(event: CalendarLikeEvent): {
  url?: string;
  platform?: JoinablePlatform;
  source?: 'meeting_url' | 'location' | 'description';
} {
  for (const source of ['meeting_url', 'location', 'description'] as const) {
    const raw = String(event[source] || '');
    if (!raw) continue;
    // Scan the raw text first so URLs inside tag attributes (e.g.
    // `<a href="...">`) survive, then the markup-stripped text.
    const haystacks = [raw, stripMarkup(raw)];
    for (const text of haystacks) {
      for (const match of text.match(URL_PATTERN) ?? []) {
        const url = cleanUrl(match);
        const platform = platformOf(url);
        if (platform) return { url, platform, source };
      }
    }
  }
  return {};
}

function toMs(value: string | number | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

interface JoinableCandidate {
  event: CalendarLikeEvent;
  url: string;
  platform: JoinablePlatform;
  startMs: number;
  /**
   * The series id, only when the URL came from the provider's conference
   * field: free-text location / description URLs never inherit the series'
   * standing grant (an organizer could point one occurrence elsewhere).
   */
  seriesId?: string;
}

/** Events with a joinable meeting URL that start in [fromMs, toMs], earliest first. */
function joinableCandidates(
  events: readonly CalendarLikeEvent[],
  fromMs: number,
  windowEndMs: number
): JoinableCandidate[] {
  const candidates: JoinableCandidate[] = [];
  for (const event of events) {
    const { url, platform, source } = extractMeetingUrl(event);
    if (!url || !platform) continue;
    const startMs = toMs(event.start);
    if (startMs === undefined) continue;
    if (startMs < fromMs || startMs > windowEndMs) continue;
    const seriesId = source === 'meeting_url' ? event.series_id?.trim() : undefined;
    candidates.push({ event, url, platform, startMs, ...(seriesId ? { seriesId } : {}) });
  }
  return candidates.sort((left, right) => left.startMs - right.startMs);
}

export interface UpcomingMeeting {
  title?: string;
  url: string;
  platform: JoinablePlatform;
  series_id?: string;
  start: string;
  end?: string;
  /** Seconds from now until start. */
  starts_in_sec: number;
}

/**
 * Joinable meetings starting between `from_min` and `to_min` minutes from now
 * (inclusive start, exclusive end), earliest first — the pre-meeting readiness
 * window.
 */
export function listUpcomingMeetings(
  events: readonly CalendarLikeEvent[],
  options: { now?: string | number; from_min: number; to_min: number }
): UpcomingMeeting[] {
  const now = toMs(options.now) ?? Date.now();
  const fromMs = now + options.from_min * 60_000;
  const toMsExclusive = now + options.to_min * 60_000;
  return joinableCandidates(events, fromMs, toMsExclusive - 1).map((candidate) => ({
    ...(candidate.event.title ? { title: candidate.event.title } : {}),
    url: candidate.url,
    platform: candidate.platform,
    ...(candidate.seriesId ? { series_id: candidate.seriesId } : {}),
    start: candidate.event.start as string,
    ...(candidate.event.end ? { end: candidate.event.end } : {}),
    starts_in_sec: Math.round((candidate.startMs - now) / 1000),
  }));
}

export function resolveNextMeetingTarget(
  events: readonly CalendarLikeEvent[],
  options: ResolveNextTargetOptions = {}
): ResolvedMeetingTarget {
  const now = toMs(options.now) ?? Date.now();
  const startedAgoMs = Math.max(0, options.started_ago_min ?? 5) * 60_000;
  const startsWithinMs = Math.max(0, options.starts_within_min ?? 10) * 60_000;
  const maxDurationSec = Math.max(60, options.max_duration_sec ?? 5400);

  const next = joinableCandidates(events, now - startedAgoMs, now + startsWithinMs)[0];
  if (!next) return { found: false, reason: 'no joinable meeting in window' };

  const endMs = toMs(next.event.end) ?? next.startMs + 30 * 60_000;
  const joinDurationSec = Math.min(maxDurationSec, Math.max(60, Math.round((endMs - now) / 1000)));
  const startDate = new Date(next.startMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  const fileSlug = `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())}T${pad(startDate.getHours())}${pad(startDate.getMinutes())}-${next.platform}`;
  return {
    found: true,
    ...(next.event.title ? { title: next.event.title } : {}),
    url: next.url,
    platform: next.platform,
    ...(next.seriesId ? { series_id: next.seriesId } : {}),
    ...(next.event.start ? { start: next.event.start } : {}),
    ...(next.event.end ? { end: next.event.end } : {}),
    starts_in_sec: Math.round((next.startMs - now) / 1000),
    join_duration_sec: joinDurationSec,
    file_slug: fileSlug,
  };
}
