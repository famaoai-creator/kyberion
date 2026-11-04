'use client';

import { frontDeskFetch as fetch } from '../lib/front-desk-fetch';

import * as React from 'react';
import { Badge, Button, Callout, Disclosure, Section, Skeleton } from '@agent/shared-ui';
import { compareDecisionUrgency, groupByDecision } from '@agent/core/surface/decision-brief';
import { conciergeText, frontDeskText } from '../lib/i18n';
import { postApprovalDecision } from '../lib/approval-decision-client';
import { formatApprovalFailure } from '../lib/approval-failure';
import { parseDecisionBrief, renderDisplayText } from '../lib/decision-brief-view';
import type { ConciergeSummary } from '../lib/summary-event';
import { BriefStateBadge, DecisionBriefBlock } from './decision-brief';
import { SELECTED_TENANT_PARAM, SYSTEM_SELECTION } from '../lib/tenant-context';
import type {
  PersonalAggregate,
  PersonalCompanyCard,
  PersonalScopeCard,
} from '../lib/personal-aggregate';

type ApprovalItem = ConciergeSummary['approval_queue'][number];

function parseApprovals(value: unknown): ApprovalItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ApprovalItem[] => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    if (
      !['id', 'channel', 'storage_channel', 'title', 'requested_at'].every(
        (field) => typeof item[field] === 'string'
      )
    )
      return [];
    const brief = parseDecisionBrief(item.brief);
    const { brief: _dropped, ...rest } = item;
    return [{ ...(rest as unknown as ApprovalItem), ...(brief ? { brief } : {}) }];
  });
}

function isScopeCard(entry: unknown): entry is PersonalScopeCard {
  return (
    Boolean(entry) &&
    typeof entry === 'object' &&
    typeof (entry as { counts?: unknown }).counts === 'object' &&
    (entry as { counts?: unknown }).counts !== null
  );
}

function withApprovals<T extends PersonalScopeCard>(card: T): T {
  return { ...card, approvals: parseApprovals(card.approvals) };
}

function parseAggregate(value: unknown): PersonalAggregate | null {
  if (!value || typeof value !== 'object' || (value as { ok?: unknown }).ok !== true) return null;
  const { companies, system } = value as { companies?: unknown; system?: unknown };
  if (!Array.isArray(companies)) return null;
  return {
    companies: companies
      .filter(
        (entry): entry is PersonalCompanyCard =>
          isScopeCard(entry) &&
          typeof (entry as PersonalCompanyCard).tenant_slug === 'string' &&
          typeof (entry as PersonalCompanyCard).display_name === 'string'
      )
      .map(withApprovals),
    ...(isScopeCard(system) ? { system: withApprovals(system) } : {}),
  };
}

interface ScopeCardView {
  key: string;
  title: string;
  value: string;
  card: PersonalScopeCard;
}

interface TenantedApproval extends ApprovalItem {
  scopeTitle: string;
  scopeValue: string;
}

/**
 * The personal (個人) view of 決める: first every pending decision across the
 * viewer's companies (tenant badge, most urgent first, identical requests
 * folded), decided right here through the tenant-scoped decision route — the
 * server re-resolves the viewer and checks membership in the approval's own
 * tenant, so this view widens nothing. Below, one compact line per company
 * with its other counts and a link that switches into it (a full navigation,
 * so every screen fetches the new scope again).
 */
export function PersonalOverview({ locale }: { locale: 'en' | 'ja' }) {
  const [aggregate, setAggregate] = React.useState<PersonalAggregate | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean } | null>(null);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/personal-summary', { signal });
      const parsed = parseAggregate(await response.json().catch(() => null));
      if (!response.ok || !parsed) throw new Error('Invalid personal summary response');
      setAggregate(parsed);
    } catch {
      if (!signal?.aborted) setFailed(true);
    }
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const decide = React.useCallback(
    async (item: TenantedApproval, decision: 'approved' | 'rejected') => {
      setBusyId(item.id);
      try {
        await postApprovalDecision(item, decision);
        setNotice({
          text: conciergeText(
            decision === 'approved' ? 'home.approved_notice' : 'home.rejected_notice',
            locale,
            { title: item.brief ? renderDisplayText(item.brief.ask, locale) : item.title }
          ),
        });
        await load();
      } catch (error) {
        setNotice({ text: formatApprovalFailure(error, locale), error: true });
      } finally {
        setBusyId(null);
      }
    },
    [load, locale]
  );

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
  const approvals: TenantedApproval[] = cards
    .flatMap(({ title, value, card }) =>
      (card.approvals ?? []).map((item) => ({ ...item, scopeTitle: title, scopeValue: value }))
    )
    .sort(compareDecisionUrgency);
  const groups = groupByDecision(approvals);

  const renderDecision = (item: TenantedApproval, others: TenantedApproval[] = []) => {
    const approveLabel =
      item.min_assurance === 'A3'
        ? frontDeskText('decide_approve_passkey', locale)
        : frontDeskText('decide_approve', locale);
    return (
      <div key={`${item.storage_channel}:${item.id}`} className="decide-card" data-kind="approval">
        <Section
          headingLevel={3}
          title={item.brief ? renderDisplayText(item.brief.ask, locale) : item.title}
        >
          <div className="decide-card-meta">
            <Badge label={item.scopeTitle} tone="info" />
            <BriefStateBadge brief={item.brief} locale={locale} />
          </div>
          {item.brief ? (
            <DecisionBriefBlock
              brief={item.brief}
              locale={locale}
              showAsk={false}
              approveLabel={approveLabel}
              rejectLabel={frontDeskText('decide_reject', locale)}
            />
          ) : null}
          <div className="decide-actions">
            <Button
              label={approveLabel}
              variant="primary"
              disabled={busyId !== null || (item.brief ? item.brief.state !== 'pending' : false)}
              onClick={() => void decide(item, 'approved')}
            />
            <Button
              label={frontDeskText('decide_reject', locale)}
              variant="danger"
              // Rejecting an expired request still clears it; a resolved one is final.
              disabled={busyId !== null || item.brief?.state === 'resolved'}
              onClick={() => void decide(item, 'rejected')}
            />
          </div>
          {others.length ? (
            <Disclosure
              summary={conciergeText('ux_a_brief_same_count', locale, {
                count: others.length + 1,
              })}
            >
              <p className="decide-muted">{conciergeText('ux_a_brief_same_lead', locale)}</p>
              <div className="decide-list brief-group">
                {others.map((other) => renderDecision(other))}
              </div>
            </Disclosure>
          ) : null}
        </Section>
      </div>
    );
  };

  return (
    <>
      {notice ? <Callout tone={notice.error ? 'danger' : 'success'} title={notice.text} /> : null}
      <Section
        title={conciergeText('ux_a_personal_title', locale)}
        description={conciergeText('ux_a_personal_lead', locale)}
      >
        {aggregate === null ? (
          <Skeleton shape="card" lines={3} label={conciergeText('ux_a_personal_title', locale)} />
        ) : groups.length === 0 ? (
          <p className="decide-muted">{conciergeText('ux_a_personal_empty', locale)}</p>
        ) : (
          <div className="decide-list">
            {groups.map(({ lead, others }) => renderDecision(lead, others))}
          </div>
        )}
      </Section>
      <Section title={frontDeskText('personal_overview_title', locale)}>
        {aggregate === null ? (
          <Skeleton
            shape="card"
            lines={3}
            label={frontDeskText('personal_overview_title', locale)}
          />
        ) : cards.length === 0 ? (
          <p className="decide-muted">{frontDeskText('personal_overview_empty', locale)}</p>
        ) : (
          <div className="decide-list personal-overview">
            {cards.map(({ key, title, value, card }) => (
              <div key={key} className="personal-scope-line">
                <p className="decide-muted">
                  {conciergeText('ux_a_personal_others', locale, {
                    name: title,
                    active: card.counts.active_missions,
                    exceptions: card.counts.exceptions,
                    outcomes: card.counts.unread_outcomes,
                  })}
                </p>
                {card.counts.pending_approvals > (card.approvals?.length ?? 0) ? (
                  <p className="decide-muted">
                    {conciergeText('ux_a_personal_more', locale, {
                      name: title,
                      count: card.counts.pending_approvals - (card.approvals?.length ?? 0),
                    })}
                  </p>
                ) : null}
                <a
                  className="decide-evidence-link"
                  href={`/?${SELECTED_TENANT_PARAM}=${encodeURIComponent(value)}`}
                >
                  {conciergeText('ux_a_personal_open_tenant', locale, { name: title })}
                </a>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
