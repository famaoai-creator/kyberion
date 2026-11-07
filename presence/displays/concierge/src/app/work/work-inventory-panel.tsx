'use client';

import { frontDeskFetch as fetch } from '../../lib/front-desk-fetch';

import * as React from 'react';
import { Badge, Button } from '@agent/shared-ui';
import { frontDeskText, type FrontDeskMessageKey } from '../../lib/i18n';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { withSelectedTenant } from '../../lib/tenant-context';
import {
  WORK_INVENTORY_STATUSES,
  parseWorkInventoryPanel,
  selectedCompany,
  workInventoryPanelPath,
  type WorkInventoryPanelView,
} from '../../lib/requests-view';

/**
 * 業務の自動化候補 (WI-11), moved with 進み具合 from presence-studio into
 * 仕事 › 依頼. The work-inventory hearing hands off here. Additive: a failed
 * read hides the panel and never blocks the request list.
 */
export function WorkInventoryPanel({ search }: { search: string }) {
  const { t, locale } = useConciergeI18n();
  const ft = React.useCallback(
    (key: FrontDeskMessageKey, params?: Record<string, string | number>) =>
      frontDeskText(key, locale, params),
    [locale]
  );
  const params = React.useMemo(() => new URLSearchParams(search), [search]);
  const path = workInventoryPanelPath(params);
  const [panel, setPanel] = React.useState<WorkInventoryPanelView | null>(null);

  React.useEffect(() => {
    let live = true;
    setPanel(null);
    void fetch(path, { cache: 'no-store' })
      .then(async (response) =>
        response.ok ? parseWorkInventoryPanel(await response.json()) : null
      )
      .catch(() => null)
      .then((value) => {
        if (live) setPanel(value);
      });
    return () => {
      live = false;
    };
  }, [path]);

  if (!panel) return null;
  const consent = panel.consent;
  return (
    <section className="requests-group requests-inventory" aria-labelledby="work-inventory-heading">
      <h2 id="work-inventory-heading" className="requests-heading">
        {ft('progress_work_inventory_title')}
      </h2>
      {!panel.scoped ? (
        <p className="requests-row__meta">{t('ia_work_requests_inventory_choose_company')}</p>
      ) : (
        <>
          <ul className="requests-inventory__counts">
            {WORK_INVENTORY_STATUSES.map((status) => (
              <li key={status}>
                <Badge
                  label={`${ft(`progress_work_inventory_status_${status}` as FrontDeskMessageKey)} ${panel.counts[status]}`}
                />
              </li>
            ))}
          </ul>
          {panel.candidates.length === 0 ? (
            <p className="requests-row__meta">{ft('progress_work_inventory_empty')}</p>
          ) : (
            <ul className="requests-list">
              {panel.candidates.map((item) => {
                const ratio = Math.max(0, Math.min(100, Math.round(item.automatable_ratio * 100)));
                return (
                  <li key={item.entry_id} className="requests-inventory__row">
                    <span className="requests-row__head">
                      <span className="requests-row__title">{item.title}</span>
                      <Badge
                        label={ft(
                          `progress_work_inventory_status_${item.status}` as FrontDeskMessageKey
                        )}
                      />
                    </span>
                    <span className="requests-row__meta">
                      {ft('progress_work_inventory_score_label')}{' '}
                      {Math.round(item.score * 10000) / 10000} ·{' '}
                      {ft('progress_work_inventory_hours_label', {
                        hours: Math.round(item.hours_per_month * 10) / 10,
                      })}
                    </span>
                    <progress
                      className="requests-row__bar"
                      max={100}
                      value={ratio}
                      aria-label={ft('progress_work_inventory_automatable_label')}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {consent ? (
        <p className="requests-row__meta">
          {!consent.active && !consent.pending_summaries
            ? ft('progress_work_inventory_consent_none')
            : consent.expires_soonest
              ? ft('progress_work_inventory_consent_line', {
                  active: consent.active,
                  expires: consent.expires_soonest.slice(0, 10),
                  pending: consent.pending_summaries,
                })
              : ft('progress_work_inventory_consent_line_no_expiry', {
                  active: consent.active,
                  pending: consent.pending_summaries,
                })}
        </p>
      ) : null}
      <div className="requests-detail__block">
        <Button
          label={ft('progress_work_inventory_start')}
          href={withSelectedTenant(panel.start_href, selectedCompany(params))}
        />
        {panel.operator_hint ? (
          <p className="requests-row__meta">{ft('progress_work_inventory_operator_hint')}</p>
        ) : null}
      </div>
    </section>
  );
}
