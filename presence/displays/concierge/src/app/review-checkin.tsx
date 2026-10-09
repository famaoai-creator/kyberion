'use client';

import { frontDeskFetch as fetch } from '../lib/front-desk-fetch';

import * as React from 'react';
import { Button, Section } from '@agent/shared-ui';
import { frontDeskText } from '../lib/i18n';
import { useConciergeI18n } from '../lib/use-concierge-i18n';
import {
  parseObservationReview,
  type ObservationReviewDigest,
} from '../lib/observation-review-types';
import { startReviewWatch } from '../lib/review-watch';

export function ReviewCheckin({ tenant }: { tenant: string }) {
  const { locale } = useConciergeI18n();
  const [digest, setDigest] = React.useState<ObservationReviewDigest | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [watching, setWatching] = React.useState(false);
  const [error, setError] = React.useState(false);
  const stopRef = React.useRef<(() => void) | null>(null);
  const eligible = tenant !== 'all' && tenant !== '__no_tenant__' && !!tenant;
  React.useEffect(
    () => () => {
      stopRef.current?.();
    },
    []
  );
  const begin = (repeat: boolean) => {
    stopRef.current?.();
    setError(false);
    setDigest(null);
    setWatching(repeat);
    stopRef.current = startReviewWatch({
      repeat,
      read: async (signal) => {
        const response = await fetch(
          `/api/work-inventory/review-digest?tenant=${encodeURIComponent(tenant)}`,
          {
            signal,
            cache: 'no-store',
          }
        );
        if (!response.ok) throw new Error('Review unavailable');
        return parseObservationReview(await response.json());
      },
      onChecking: () => setChecking(true),
      onResult: (result) => {
        setDigest(result);
        setChecking(false);
      },
      onStop: () => {
        setWatching(false);
        setChecking(false);
      },
      onError: () => {
        setDigest(null);
        setError(true);
      },
    });
  };
  return (
    <Section title={frontDeskText('review_title', locale)}>
      <p>{frontDeskText('review_explanation', locale)}</p>
      <p aria-live="polite">
        {!eligible
          ? frontDeskText('review_tenant_required', locale)
          : error
            ? frontDeskText('review_error', locale)
            : checking
              ? frontDeskText('review_checking', locale)
              : digest
                ? frontDeskText('review_counts', locale, {
                    pending: digest.pendingCount,
                    attention: digest.attentionCount,
                  })
                : frontDeskText('review_idle', locale)}
        {digest?.limited ? ` ${frontDeskText('review_limited', locale)}` : ''}
      </p>
      {digest ? (
        <p>
          <time dateTime={digest.checkedAt}>
            {frontDeskText('review_updated_at', locale, {
              time: new Date(digest.checkedAt).toLocaleString(locale),
            })}
          </time>
        </p>
      ) : null}
      {watching ? <p>{frontDeskText('review_watching', locale)}</p> : null}
      <Button
        label={frontDeskText('review_now', locale)}
        disabled={!eligible || checking || watching}
        onClick={() => begin(false)}
      />
      <Button
        label={frontDeskText('review_start', locale)}
        disabled={!eligible || checking || watching}
        onClick={() => begin(true)}
      />
      {watching || checking ? (
        <Button
          label={frontDeskText('review_stop', locale)}
          onClick={() => {
            stopRef.current?.();
            setDigest(null);
          }}
        />
      ) : null}
      <p>
        <a href="/settings#settings-recording">{frontDeskText('review_settings', locale)}</a>
      </p>
    </Section>
  );
}
