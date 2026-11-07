'use client';

import { frontDeskFetch as fetch } from '../../lib/front-desk-fetch';

import * as React from 'react';
import Link from 'next/link';
import { Badge, Button, Callout, PageHeader, Skeleton } from '@agent/shared-ui';
import { frontDeskText, type FrontDeskMessageKey } from '../../lib/i18n';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { useShellScope } from '../../lib/shell-scope';
import { withSelectedTenant } from '../../lib/tenant-context';
import {
  HELP_ACCESS_UNKNOWN,
  helpLessonsDone,
  helpTryHref,
  parseHelpAccess,
  parseHelpCatalog,
  parseHelpProgress,
  type HelpAccess,
  type HelpLessonStatus,
  type HelpLinks,
  type HelpTrack,
} from '../../lib/help-view';
import './help.css';

const LEVEL_KEY: Record<HelpTrack['level'], FrontDeskMessageKey> = {
  beginner: 'training_level_beginner',
  intermediate: 'training_level_intermediate',
  advanced: 'training_level_advanced',
};

const STATUS_KEY: Record<HelpLessonStatus, FrontDeskMessageKey> = {
  not_started: 'training_status_not_started',
  in_progress: 'training_status_in_progress',
  complete: 'training_status_complete',
};

/** Refusals `/api/training/me` writes for the person; anything else is the generic failure. */
const REFUSAL_KEYS = new Set<FrontDeskMessageKey>([
  'training_member_not_found',
  'training_mark_done_local_only',
  'training_progress_invalid',
]);

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; tracks: HelpTrack[] };
type Mark =
  { state: 'saving' } | { state: 'recorded' } | { state: 'failed'; key: FrontDeskMessageKey };

/**
 * 使い方 (`/help`, `/help/<track>`), moved from presence-studio
 * (`static/help.js`, Kyberion server phase 2). The track list and lessons come
 * from the governed catalog; the viewer's own lesson status from
 * `/api/training/me` (best effort: someone who is not a registered member
 * still sees every lesson, just without a status).
 */
export function HelpPage({ links, trackId }: { links: HelpLinks; trackId: string | null }) {
  const { locale } = useConciergeI18n();
  const ft = React.useCallback(
    (key: FrontDeskMessageKey, params?: Record<string, string | number>) =>
      frontDeskText(key, locale, params),
    [locale]
  );
  const scope = useShellScope();
  const [load, setLoad] = React.useState<Load>({ state: 'loading' });
  const [progress, setProgress] = React.useState<Record<string, HelpLessonStatus>>({});
  const [marks, setMarks] = React.useState<Record<string, Mark>>({});
  const [access, setAccess] = React.useState<HelpAccess>(HELP_ACCESS_UNKNOWN);
  // The selected tenant is only known in the browser; adding it after mount
  // keeps the server-rendered href and the first client render identical.
  const [inboxHref, setInboxHref] = React.useState(links.inbox);
  // A mark that already answered is newer than the page's initial progress read.
  const marked = React.useRef(false);
  const statusRefs = React.useRef<Record<string, HTMLParagraphElement | null>>({});

  React.useEffect(() => {
    setInboxHref(withSelectedTenant(links.inbox, scope.tenant || null));
  }, [links.inbox, scope.tenant]);

  React.useEffect(() => {
    let live = true;
    const read = async (url: string) => {
      const response = await fetch(url, { cache: 'no-store' });
      return { ok: response.ok, body: await response.json().catch(() => null) };
    };
    void Promise.allSettled([
      read('/api/training/catalog'),
      read('/api/training/me'),
      read(`/api/front-desk/nav?locale=${locale}`),
    ]).then(([catalog, own, nav]) => {
      if (!live) return;
      const tracks =
        catalog.status === 'fulfilled' && catalog.value.ok
          ? parseHelpCatalog(catalog.value.body)
          : null;
      setLoad(tracks ? { state: 'ready', tracks } : { state: 'failed' });
      if (own.status === 'fulfilled' && own.value.ok && !marked.current) {
        setProgress(parseHelpProgress(own.value.body));
      }
      if (nav.status === 'fulfilled' && nav.value.ok) setAccess(parseHelpAccess(nav.value.body));
    });
    return () => {
      live = false;
    };
  }, [locale]);

  const markDone = async (lessonId: string) => {
    setMarks((current) => ({ ...current, [lessonId]: { state: 'saving' } }));
    let mark: Mark = { state: 'failed', key: 'training_mark_done_failed' };
    try {
      const response = await fetch('/api/training/me', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lesson_id: lessonId, status: 'complete' }),
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error_code?: unknown;
      } | null;
      if (response.ok && body?.ok) {
        marked.current = true;
        setProgress(parseHelpProgress(body));
        mark = { state: 'recorded' };
      } else if (REFUSAL_KEYS.has(body?.error_code as FrontDeskMessageKey)) {
        mark = { state: 'failed', key: body?.error_code as FrontDeskMessageKey };
      }
    } catch {
      /* keep the generic failure */
    }
    setMarks((current) => ({ ...current, [lessonId]: mark }));
    // The 「できた」 button is gone after a success: keep focus on the answer.
    if (mark.state === 'recorded') {
      requestAnimationFrame(() => statusRefs.current[lessonId]?.focus());
    }
  };

  const track =
    load.state === 'ready' && trackId ? load.tracks.find((item) => item.id === trackId) : null;
  const heading = track ? track.title : ft('help_training_title');
  type Shortcut = { title: FrontDeskMessageKey; sub: FrontDeskMessageKey; href: string };
  const shortcuts: Shortcut[] = [
    { title: 'nav_ask', sub: 'nav_ask_sub', href: links.ask },
    ...(access.inbox ? [{ title: 'nav_decide', sub: 'nav_decide_sub', href: inboxHref }] : []),
    { title: 'nav_progress', sub: 'nav_progress_sub', href: links.progress },
    ...(access.settings
      ? [{ title: 'help_engine_title', sub: 'help_engine_sub', href: links.engine }]
      : []),
  ] as Shortcut[];

  return (
    <div className="kb-page help-page" data-width="wide">
      <PageHeader title={ft('nav_help')} subtitle={ft('nav_help_sub')} />

      <section className="help-block" aria-labelledby="help-training-heading">
        {trackId ? (
          <Link className="help-back" href="/help">
            {ft('training_back')}
          </Link>
        ) : null}
        <h2 id="help-training-heading" className="help-heading">
          {heading}
        </h2>
        {load.state === 'loading' ? (
          <Skeleton shape="card" />
        ) : load.state === 'failed' ? (
          <Callout tone="danger" title={ft('help_training_unavailable')} />
        ) : trackId && !track ? (
          <Callout tone="warning" title={ft('help_track_not_found')} />
        ) : track ? (
          <>
            <p className="help-meta">
              {track.audience} · {ft(LEVEL_KEY[track.level])} ·{' '}
              {ft('help_lessons_done', {
                done: helpLessonsDone(track, progress),
                total: track.lessons.length,
              })}
            </p>
            <ol className="help-lessons">
              {track.lessons.map((lesson) => {
                const status = progress[lesson.id] ?? 'not_started';
                const mark = marks[lesson.id];
                const tryHref = helpTryHref(lesson, { ...links, inbox: inboxHref }, access);
                return (
                  <li key={lesson.id} className="help-lesson" data-lesson-id={lesson.id}>
                    <div className="help-lesson__head">
                      <h3 className="help-lesson__title">{lesson.title}</h3>
                      <Badge
                        label={ft(STATUS_KEY[status])}
                        tone={status === 'complete' ? 'success' : 'neutral'}
                      />
                    </div>
                    <p>{lesson.goal}</p>
                    <p className="help-meta">
                      {ft('training_done_prefix')} {lesson.check.text}
                    </p>
                    <div className="help-lesson__actions">
                      {tryHref ? (
                        <Button label={ft('training_try')} variant="primary" href={tryHref} />
                      ) : null}
                      {status === 'complete' ? null : (
                        <Button
                          label={ft('training_mark_done')}
                          variant="secondary"
                          disabled={mark?.state === 'saving'}
                          onClick={() => void markDone(lesson.id)}
                        />
                      )}
                    </div>
                    {/* One persistent live region per lesson, so the answer is announced. */}
                    <p
                      role="status"
                      tabIndex={-1}
                      ref={(node) => {
                        statusRefs.current[lesson.id] = node;
                      }}
                      className={
                        mark?.state === 'failed' ? 'help-meta kb-text--danger' : 'help-meta'
                      }
                    >
                      {mark?.state === 'recorded'
                        ? ft('training_mark_done_recorded')
                        : mark?.state === 'failed'
                          ? ft(mark.key)
                          : ''}
                    </p>
                  </li>
                );
              })}
            </ol>
          </>
        ) : (
          <>
            <p className="help-meta">{ft('help_training_lead')}</p>
            <ul className="help-tracks">
              {load.tracks.map((item) => (
                <li key={item.id}>
                  <Link className="help-track" href={`/help/${encodeURIComponent(item.id)}`}>
                    <span className="help-track__title">{item.title}</span>
                    <span className="help-meta">
                      {item.audience} · {ft(LEVEL_KEY[item.level])}
                    </span>
                    <span className="help-meta">
                      {ft('help_lessons_done', {
                        done: helpLessonsDone(item, progress),
                        total: item.lessons.length,
                      })}
                    </span>
                    <span className="help-track__open">{ft('training_open')}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {trackId ? null : (
        <section className="help-block" aria-labelledby="help-where-heading">
          <h2 id="help-where-heading" className="help-heading">
            {ft('help_where_title')}
          </h2>
          <ul className="help-tracks">
            {shortcuts.map(({ title, sub, href }) => (
              <li key={title}>
                {/* Studio pages not yet moved are absolute links; a plain <a> navigates either way. */}
                <a className="help-track" href={href}>
                  <span className="help-track__title">{ft(title)}</span>
                  <span className="help-meta">{ft(sub)}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
