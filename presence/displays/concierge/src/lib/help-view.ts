/**
 * 使い方 (`/help`, `/help/<track>`): pure parsing and link resolution for the
 * training page moved from presence-studio (`static/help.js`). Everything the
 * page shows comes from the governed training catalog
 * (`GET /api/training/catalog`) and the viewer's own progress
 * (`GET /api/training/me`); nothing here invents copy.
 */

export type HelpLevel = 'beginner' | 'intermediate' | 'advanced';
export type HelpLessonStatus = 'not_started' | 'in_progress' | 'complete';
export type HelpTryKind = 'ask' | 'decide' | 'progress' | 'settings';

export interface HelpLesson {
  id: string;
  title: string;
  goal: string;
  try: { kind: HelpTryKind; prefill?: string };
  check: { text: string };
}

export interface HelpTrack {
  id: string;
  level: HelpLevel;
  title: string;
  audience: string;
  lessons: HelpLesson[];
}

/** Where the "try it" and shortcut links go; Studio pages not yet moved stay absolute. */
export interface HelpLinks {
  ask: string;
  inbox: string;
  progress: string;
  settings: string;
  engine: string;
}

const LEVELS: readonly HelpLevel[] = ['beginner', 'intermediate', 'advanced'];
const STATUSES: readonly HelpLessonStatus[] = ['not_started', 'in_progress', 'complete'];
const TRY_KINDS: readonly HelpTryKind[] = ['ask', 'decide', 'progress', 'settings'];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseLesson(value: unknown): HelpLesson | null {
  const lesson = record(value);
  const tryIt = record(lesson?.try);
  const check = record(lesson?.check);
  if (!lesson || !tryIt || !check) return null;
  const id = text(lesson.id);
  const title = text(lesson.title);
  const goal = text(lesson.goal);
  const checkText = text(check.text);
  const kind = tryIt.kind as HelpTryKind;
  if (!id || title === null || goal === null || checkText === null) return null;
  if (!TRY_KINDS.includes(kind)) return null;
  const prefill = text(tryIt.prefill);
  return {
    id,
    title,
    goal,
    try: prefill === null ? { kind } : { kind, prefill },
    check: { text: checkText },
  };
}

function parseTrack(value: unknown): HelpTrack | null {
  const track = record(value);
  if (!track || !Array.isArray(track.lessons)) return null;
  const id = text(track.id);
  const title = text(track.title);
  const audience = text(track.audience);
  const level = track.level as HelpLevel;
  if (!id || title === null || audience === null || !LEVELS.includes(level)) return null;
  const lessons = track.lessons.map(parseLesson);
  if (lessons.some((lesson) => lesson === null)) return null;
  return { id, level, title, audience, lessons: lessons as HelpLesson[] };
}

/** `{ ok: true, catalog: { tracks } }` → tracks, or `null` when the shape is wrong. */
export function parseHelpCatalog(value: unknown): HelpTrack[] | null {
  const body = record(value);
  const catalog = record(body?.catalog);
  if (body?.ok !== true || !catalog || !Array.isArray(catalog.tracks)) return null;
  const tracks = catalog.tracks.map(parseTrack);
  return tracks.some((track) => track === null) ? null : (tracks as HelpTrack[]);
}

/** `{ ok: true, progress: { lessons } }` → lesson id → status. Anything else → empty. */
export function parseHelpProgress(value: unknown): Record<string, HelpLessonStatus> {
  const body = record(value);
  const lessons = record(record(body?.progress)?.lessons);
  if (body?.ok !== true || !lessons) return {};
  const out: Record<string, HelpLessonStatus> = {};
  for (const [id, entry] of Object.entries(lessons)) {
    const status = record(entry)?.status as HelpLessonStatus;
    if (STATUSES.includes(status)) out[id] = status;
  }
  return out;
}

/** The track id from a `/help/<track>` path segment (already decoded by Next), or null. */
export function helpTrackId(segment: string | string[] | undefined): string | null {
  const value = Array.isArray(segment) ? segment[0] : segment;
  return value && value.length > 0 ? value : null;
}

/** "Try it" target for a lesson (studio mapping, except decide → あなた待ち). */
export function helpTryHref(lesson: HelpLesson, links: HelpLinks): string {
  switch (lesson.try.kind) {
    case 'ask':
      return `${links.ask}?prefill=${encodeURIComponent(lesson.try.prefill ?? '')}`;
    case 'decide':
      // Decisions now wait in あなた待ち (Concierge), not on the progress page.
      return links.inbox;
    case 'progress':
      return links.progress;
    default:
      return links.settings;
  }
}

export function helpLessonsDone(
  track: HelpTrack,
  progress: Record<string, HelpLessonStatus>
): number {
  return track.lessons.filter((lesson) => progress[lesson.id] === 'complete').length;
}
