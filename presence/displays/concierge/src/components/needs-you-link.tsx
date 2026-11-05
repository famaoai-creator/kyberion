'use client';

import * as React from 'react';
import { Button } from '@agent/shared-ui';
import { conciergeText, resolveConciergeLocale } from '../lib/i18n';
import {
  fetchNeedsYouSummary,
  inboxHref,
  type NeedsYouReason,
  type NeedsYouSummary,
} from '../lib/needs-you-client';

/**
 * Where a decision UI used to be: the one needs-you count for that reason and
 * a link to decide it in `/inbox` (contract §1 "no duplicated lists"). The
 * count is `/api/v1/needs-you/summary` — the same number `/inbox` shows.
 */
export function NeedsYouLink({
  reason,
  lead = true,
  locale: rawLocale,
}: {
  reason?: NeedsYouReason;
  /** Any surface locale (ops passes its own); resolved to a Concierge locale. */
  locale: string;
  /** Show the one-line "decisions are made in one place" explanation. */
  lead?: boolean;
}) {
  const locale = resolveConciergeLocale(rawLocale);
  const [summary, setSummary] = React.useState<NeedsYouSummary | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    fetchNeedsYouSummary(controller.signal)
      .then(setSummary)
      .catch(() => {
        // Advisory: without a count the link still leads to the queue.
      });
    return () => controller.abort();
  }, []);
  const count = summary ? (reason ? summary.byReason[reason] : summary.total) : null;
  return (
    <div className="inbox-elsewhere" data-testid="needs-you-link">
      {count !== null ? (
        <strong>
          {count > 0
            ? conciergeText('ia_inbox_elsewhere', locale, { count })
            : conciergeText('ia_inbox_elsewhere_none', locale)}
        </strong>
      ) : null}
      <Button
        variant="primary"
        href={inboxHref({ reason, overdue: false })}
        label={conciergeText('ia_inbox_elsewhere_link', locale)}
      />
      {lead ? (
        <span className="kb-text kb-text--muted">
          {conciergeText('ia_inbox_elsewhere_lead', locale)}
        </span>
      ) : null}
    </div>
  );
}
