'use client';

import { frontDeskFetch as fetch } from '../lib/front-desk-fetch';

import * as React from 'react';
import { Callout, Section, Skeleton } from '@agent/shared-ui';
import { frontDeskText } from '../lib/i18n';
import { SELECTED_TENANT_PARAM, SYSTEM_SELECTION } from '../lib/tenant-context';
import type {
  PersonalAggregate,
  PersonalCompanyCard,
  PersonalScopeCard,
} from '../lib/personal-aggregate';

function isScopeCard(entry: unknown): entry is PersonalScopeCard {
  return (
    Boolean(entry) &&
    typeof entry === 'object' &&
    typeof (entry as { counts?: unknown }).counts === 'object' &&
    (entry as { counts?: unknown }).counts !== null
  );
}

function parseAggregate(value: unknown): PersonalAggregate | null {
  if (!value || typeof value !== 'object' || (value as { ok?: unknown }).ok !== true) return null;
  const { companies, system } = value as { companies?: unknown; system?: unknown };
  if (!Array.isArray(companies)) return null;
  return {
    companies: companies.filter(
      (entry): entry is PersonalCompanyCard =>
        isScopeCard(entry) &&
        typeof (entry as PersonalCompanyCard).tenant_slug === 'string' &&
        typeof (entry as PersonalCompanyCard).display_name === 'string'
    ),
    ...(isScopeCard(system) ? { system } : {}),
  };
}

interface ScopeCardView {
  key: string;
  title: string;
  value: string;
  card: PersonalScopeCard;
}

/**
 * The personal (個人) view of 決める: one card per company with its counts and
 * a link that switches into that company, plus a システム card for company-less
 * items (all-company viewers only). It never lists the scopes' items. The link
 * is a full navigation so every screen fetches the new scope again.
 */
export function PersonalOverview({ locale }: { locale: 'en' | 'ja' }) {
  const [aggregate, setAggregate] = React.useState<PersonalAggregate | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    const controller = new AbortController();
    fetch('/api/personal-summary', { signal: controller.signal })
      .then(async (response) => {
        const parsed = parseAggregate(await response.json().catch(() => null));
        if (!response.ok || !parsed) throw new Error('Invalid personal summary response');
        setAggregate(parsed);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);

  if (failed) {
    return <Callout tone="danger" title={frontDeskText('personal_overview_error', locale)} />;
  }
  const cards: ScopeCardView[] = aggregate
    ? [
        ...aggregate.companies.map((company) => ({
          key: company.tenant_slug,
          title: company.display_name,
          value: company.tenant_slug,
          card: company,
        })),
        ...(aggregate.system
          ? [
              {
                key: SYSTEM_SELECTION,
                title: frontDeskText('tenant_system_label', locale),
                value: SYSTEM_SELECTION,
                card: aggregate.system,
              },
            ]
          : []),
      ]
    : [];
  return (
    <Section
      title={frontDeskText('personal_overview_title', locale)}
      description={frontDeskText('personal_overview_lead', locale)}
    >
      {aggregate === null ? (
        <Skeleton shape="card" lines={3} label={frontDeskText('personal_overview_title', locale)} />
      ) : cards.length === 0 ? (
        <p className="decide-muted">{frontDeskText('personal_overview_empty', locale)}</p>
      ) : (
        <div className="decide-list personal-overview">
          {cards.map(({ key, title, value, card }) => (
            <Section
              key={key}
              headingLevel={3}
              title={title}
              description={frontDeskText('personal_overview_counts', locale, {
                approvals: card.counts.pending_approvals,
                active: card.counts.active_missions,
                exceptions: card.counts.exceptions,
                outcomes: card.counts.unread_outcomes,
              })}
            >
              {card.headline ? <p className="decide-muted">{card.headline}</p> : null}
              <a
                className="decide-evidence-link"
                href={`/?${SELECTED_TENANT_PARAM}=${encodeURIComponent(value)}`}
              >
                {frontDeskText('personal_overview_open', locale)}
              </a>
            </Section>
          ))}
        </div>
      )}
    </Section>
  );
}
