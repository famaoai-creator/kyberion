import { describe, expect, it } from 'vitest';
import {
  helpLessonsDone,
  helpTrackId,
  helpTryHref,
  parseHelpAccess,
  parseHelpCatalog,
  parseHelpProgress,
  type HelpLesson,
  type HelpLinks,
} from './help-view';

const lesson = (id: string, kind: HelpLesson['try']['kind'], prefill?: string) => ({
  id,
  title: `Lesson ${id}`,
  goal: 'goal',
  try: prefill === undefined ? { kind } : { kind, prefill },
  check: { kind: 'self', text: 'check' },
});

const catalog = {
  ok: true,
  catalog: {
    version: '1.0.0',
    tracks: [
      {
        id: 'basics',
        level: 'beginner',
        title: 'Basics',
        audience: 'Everyone',
        lessons: [
          lesson('a', 'ask', 'Draft a reply'),
          lesson('b', 'decide'),
          lesson('c', 'settings'),
        ],
      },
    ],
  },
};

const links: HelpLinks = {
  ask: 'http://studio.example/ask',
  inbox: '/inbox?tenant=acme',
  progress: 'http://studio.example/progress',
  settings: '/settings',
  engine: '/settings#settings-engine',
};

describe('help view', () => {
  it('parses the governed catalog and refuses a malformed one', () => {
    const tracks = parseHelpCatalog(catalog);
    expect(tracks?.[0]).toMatchObject({ id: 'basics', level: 'beginner', audience: 'Everyone' });
    expect(tracks?.[0].lessons.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(parseHelpCatalog({ ok: false })).toBeNull();
    expect(parseHelpCatalog({ ok: true, catalog: { tracks: [{ id: 'x' }] } })).toBeNull();
    const badLevel = structuredClone(catalog);
    badLevel.catalog.tracks[0].level = 'expert';
    expect(parseHelpCatalog(badLevel)).toBeNull();
  });

  it('reads only known lesson statuses from the viewer progress', () => {
    expect(
      parseHelpProgress({
        ok: true,
        progress: { lessons: { a: { status: 'complete' }, b: { status: 'weird' }, c: 'x' } },
      })
    ).toEqual({ a: 'complete' });
    expect(parseHelpProgress({ ok: false, error: 'not a member' })).toEqual({});
    expect(parseHelpProgress(null)).toEqual({});
  });

  it('sends each "try it" to the page that does it', () => {
    const [ask, decide, settings] = parseHelpCatalog(catalog)![0].lessons;
    expect(helpTryHref(ask, links)).toBe('http://studio.example/ask?prefill=Draft%20a%20reply');
    expect(helpTryHref(decide, links)).toBe('/inbox?tenant=acme');
    expect(helpTryHref({ ...decide, try: { kind: 'progress' } }, links)).toBe(
      'http://studio.example/progress'
    );
    expect(helpTryHref(settings, links)).toBe('/settings');
  });

  it('never sends a viewer to a page their role cannot open', () => {
    const [, decide, settings] = parseHelpCatalog(catalog)![0].lessons;
    const viewer = parseHelpAccess({
      ok: true,
      items: [
        { id: 'inbox', allowed: false },
        { id: 'settings', allowed: false },
      ],
    });
    expect(viewer).toEqual({ inbox: false, settings: false });
    expect(helpTryHref(decide, links, viewer)).toBe('http://studio.example/progress');
    expect(helpTryHref(settings, links, viewer)).toBeNull();
    // An item missing from the nav is not allowed; an unreadable nav is "unknown" (allowed).
    expect(parseHelpAccess({ ok: true, items: [] })).toEqual({ inbox: false, settings: false });
    expect(parseHelpAccess(null)).toEqual({ inbox: true, settings: true });
  });

  it('counts completed lessons and reads the track segment', () => {
    const track = parseHelpCatalog(catalog)![0];
    expect(helpLessonsDone(track, { a: 'complete', b: 'in_progress' })).toBe(1);
    expect(helpTrackId('basics')).toBe('basics');
    expect(helpTrackId(['basics', 'x'])).toBe('basics');
    expect(helpTrackId('')).toBeNull();
    expect(helpTrackId(undefined)).toBeNull();
  });
});
