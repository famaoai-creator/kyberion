'use client';

import * as React from 'react';
import { Badge, Disclosure } from '@agent/shared-ui';
import { conciergeText, frontDeskText, type ConciergeLocale } from '../lib/i18n';
import {
  formatInstant,
  renderDisplayText,
  type DecisionBrief,
  type DisplayText,
  type KindBrief,
} from '../lib/decision-brief-view';

/**
 * The plain-language body of a decision card, in a fixed order so the reader
 * learns where to look: 決めてほしいこと → なぜ必要か → 影響 (each answer) →
 * 推奨 → 期限 / リスク / 依頼元. Machine text lives only in the collapsed
 * 詳細 disclosure. Display only — the buttons stay with the caller.
 */
export function DecisionBriefBlock({
  brief,
  locale,
  approveLabel,
  rejectLabel,
  showAsk = true,
}: {
  brief: DecisionBrief;
  locale: ConciergeLocale;
  approveLabel?: string;
  rejectLabel?: string;
  /** False when the card title already is the ask. */
  showAsk?: boolean;
}) {
  const r = (text: DisplayText) => renderDisplayText(text, locale);
  const c = (key: Parameters<typeof conciergeText>[0], params?: Record<string, string | number>) =>
    conciergeText(key, locale, params);
  return (
    <div className="brief">
      {showAsk ? (
        <div className="brief-block">
          <p className="brief-label">{c('ux_a_brief_ask')}</p>
          <p className="brief-ask">{r(brief.ask)}</p>
        </div>
      ) : null}
      {brief.askFull ? (
        <Disclosure summary={c('ux_a_show_more')}>
          <p className="brief-text">{brief.askFull}</p>
        </Disclosure>
      ) : null}
      <div className="brief-grid">
        <div className="brief-block">
          <p className="brief-label">{c('ux_a_brief_why')}</p>
          <ul className="brief-list">
            {brief.why.map((line, index) => (
              <li key={index}>{r(line)}</li>
            ))}
          </ul>
        </div>
        <div className="brief-block">
          <p className="brief-label">{c('ux_a_brief_impact')}</p>
          <dl className="brief-impact">
            <dt>{approveLabel ?? c('ux_a_brief_on_approve')}</dt>
            <dd>{r(brief.onApprove)}</dd>
            <dt>{rejectLabel ?? c('ux_a_brief_on_reject')}</dt>
            <dd>{r(brief.onReject)}</dd>
            <dt>{c('ux_a_brief_if_silent')}</dt>
            <dd>{r(brief.ifSilent)}</dd>
          </dl>
        </div>
      </div>
      {brief.recommendation ? (
        <div className="brief-block brief-recommend">
          <p className="brief-label">{c('ux_a_brief_recommend')}</p>
          <p className="brief-text">{r(brief.recommendation)}</p>
        </div>
      ) : null}
      <div className="brief-facts">
        <span>
          <strong>{c('ux_a_brief_deadline')}</strong>{' '}
          {brief.deadline ? formatInstant(brief.deadline, locale) : c('ux_a_brief_deadline_none')}
        </span>
        {brief.risk ? (
          <Badge
            label={c('ux_a_brief_risk', { level: c(`ux_a_risk_${brief.risk}`) })}
            tone={brief.risk === 'high' || brief.risk === 'critical' ? 'danger' : 'neutral'}
          />
        ) : null}
        {brief.reversible !== undefined ? (
          <Badge
            label={c(brief.reversible ? 'ux_a_brief_reversible_yes' : 'ux_a_brief_reversible_no')}
            tone={brief.reversible ? 'neutral' : 'warning'}
          />
        ) : null}
        <span>
          <strong>{c('ux_a_brief_requester')}</strong> {r(brief.requester)}
        </span>
      </div>
      <Disclosure summary={c('ux_a_brief_details')}>
        <dl className="brief-details">
          {brief.details.map((row, index) => (
            <React.Fragment key={`${row.labelKey}-${index}`}>
              <dt>{c(row.labelKey as Parameters<typeof conciergeText>[0])}</dt>
              <dd>
                <code>{row.value}</code>
              </dd>
            </React.Fragment>
          ))}
        </dl>
      </Disclosure>
    </div>
  );
}

/** The state chip for a request that is no longer waiting (expired / already handled). */
export function BriefStateBadge({
  brief,
  locale,
}: {
  brief?: Pick<DecisionBrief, 'state'>;
  locale: ConciergeLocale;
}) {
  if (!brief || brief.state === 'pending') return null;
  return (
    <Badge
      label={conciergeText(
        brief.state === 'expired' ? 'ux_a_brief_state_expired' : 'ux_a_brief_state_resolved',
        locale
      )}
      tone="neutral"
    />
  );
}

/** Ask + per-option effect for the decision kinds without a server brief. */
export function KindBriefBlock({ brief, locale }: { brief: KindBrief; locale: ConciergeLocale }) {
  return (
    <div className="brief">
      <div className="brief-block">
        <p className="brief-label">{conciergeText('ux_a_brief_ask', locale)}</p>
        <p className="brief-ask">{renderDisplayText(brief.ask, locale)}</p>
      </div>
      {brief.impacts.length ? (
        <div className="brief-block">
          <p className="brief-label">{conciergeText('ux_a_brief_impact', locale)}</p>
          <dl className="brief-impact">
            {brief.impacts.map((impact) => (
              <React.Fragment key={impact.labelKey}>
                <dt>{frontDeskText(impact.labelKey, locale)}</dt>
                <dd>{renderDisplayText(impact.effect, locale)}</dd>
              </React.Fragment>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
