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
  helpLessonsDone,
  helpTryHref,
  parseHelpCatalog,
  parseHelpProgress,
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

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; tracks: HelpTrack[] };
type Mark = { state: 'saving' } | { state: 'recorded' } | { state: 'failed'; message: string };

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

  React.useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch('/api/training/catalog', { cache: 'no-store' });
        const tracks = parseHelpCatalog(await response.json().catch(() => null));
        if (live) setLoad(response.ok && tracks ? { state: 'ready', tracks } : { state: 'failed' });
      } catch {
        if (live) setLoad({ state: 'failed' });
      }
      try {
        const response = await fetch('/api/training/me', { cache: 'no-store' });
        if (response.ok && live) setProgress(parseHelpProgress(await response.json()));
      } catch {
        /* status badges are optional */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const markDone = async (lessonId: string) => {
    setMarks((current) => ({ ...current, [lessonId]: { state: 'saving' } }));
    let failure = ft('training_mark_done_failed');
    try {
      const response = await fetch('/api/training/me', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lesson_id: lessonId, status: 'complete' }),
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: unknown;
      } | null;
      if (response.ok && body?.ok) {
        setProgress(parseHelpProgress(body));
        setMarks((current) => ({ ...current, [lessonId]: { state: 'recorded' } }));
        return;
      }
      // 4xx answers are written for the person (not a member, not this computer).
      if (response.status < 500 && typeof body?.error === 'string') failure = body.error;
    } catch {
      /* keep the generic failure */
    }
    setMarks((current) => ({ ...current, [lessonId]: { state: 'failed', message: failure } }));
  };

  const inboxHref = withSelectedTenant(links.inbox, scope.tenant || null);
  const track =
    load.state === 'ready' && trackId ? load.tracks.find((item) => item.id === trackId) : null;

  return (
    <div className="kb-page help-page" data-width="wide">
      <PageHeader title={ft('nav_help')} subtitle={ft('nav_help_sub')} />

      <section className="help-block" aria-labelledby="help-training-heading" aria-live="polite">
        {trackId ? (
          <Link className="help-back" href="/help">
            {ft('training_back')}
          </Link>
        ) : null}
        {load.state === 'loading' ? (
          <Skeleton shape="card" />
        ) : load.state === 'failed' ? (
          <Callout tone="danger" title={ft('help_training_unavailable')} />
        ) : trackId && !track ? (
          <>
            <h2 id="help-training-heading" className="help-heading">
              {ft('help_training_title')}
            </h2>
            <Callout tone="warning" title={ft('help_track_not_found')} />
          </>
        ) : track ? (
          <>
            <h2 id="help-training-heading" className="help-heading">
              {track.title}
            </h2>
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
                return (
                  <li key={lesson.id} className="help-lesson" data-lesson-id={lesson.id}>
                    <h3 className="help-lesson__title">
                      <span>{lesson.title}</span>
                      <Badge
                        label={ft(STATUS_KEY[status])}
                        tone={status === 'complete' ? 'success' : 'neutral'}
                      />
                    </h3>
                    <p>{lesson.goal}</p>
                    <p className="help-meta">
                      {ft('training_done_prefix')} {lesson.check.text}
                    </p>
                    <div className="help-lesson__actions">
                      <Button
                        label={ft('training_try')}
                        variant="primary"
                        href={helpTryHref(lesson, { ...links, inbox: inboxHref })}
                      />
                      {status === 'complete' ? null : (
                        <Button
                          label={ft('training_mark_done')}
                          variant="secondary"
                          disabled={mark?.state === 'saving'}
                          onClick={() => void markDone(lesson.id)}
                        />
                      )}
                    </div>
                    {mark && mark.state !== 'saving' ? (
                      <p
                        role="status"
                        className={
                          mark.state === 'failed' ? 'help-meta kb-text--danger' : 'help-meta'
                        }
                      >
                        {mark.state === 'failed' ? mark.message : ft('training_mark_done_recorded')}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </>
        ) : (
          <>
            <h2 id="help-training-heading" className="help-heading">
              {ft('help_training_title')}
            </h2>
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
            {(
              [
                ['nav_ask', 'nav_ask_sub', links.ask],
                ['nav_decide', 'nav_decide_sub', inboxHref],
                ['nav_progress', 'nav_progress_sub', links.progress],
                ['help_engine_title', 'help_engine_sub', links.engine],
              ] as const
            ).map(([title, sub, href]) => (
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
