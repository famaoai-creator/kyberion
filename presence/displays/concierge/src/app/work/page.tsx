'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { Button, PageHeader } from '@agent/shared-ui';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { IA_WORK_TABS, resolveIaTab, type IaWorkTab } from '../../lib/ia-routes';
import { DestinationTabs } from '../destination-tabs';
import { KindList } from '../w/kind-list';
import { MissionPlanPanel } from '../../components/mission-plan/MissionPlanPanel';
import { RequestsPanel } from './requests-panel';

/**
 * `/work` 仕事 (MSN-SHELL-IA §1): missions as a state board plus their list,
 * the work-item kanban, and 依頼 — the viewer's requests (moved from
 * presence-studio 進み具合, Kyberion server phase 2). Replaces `/w/mission`, `/w/work_item` and the
 * console's missions / work-items sections; detail pages stay at
 * `/w/<kind>/<id>`.
 */
export default function WorkPage() {
  return (
    <React.Suspense fallback={null}>
      <Work />
    </React.Suspense>
  );
}

function Work() {
  const { t, locale } = useConciergeI18n();
  const searchParams = useSearchParams();
  const tab = resolveIaTab<IaWorkTab>(IA_WORK_TABS, searchParams?.get('tab') ?? null);
  // ミッションを計画 is the page's primary action (it lived in the console's
  // former missions section); `?plan=1` opens it directly.
  const [planning, setPlanning] = React.useState(searchParams?.get('plan') === '1');
  const [listRevision, setListRevision] = React.useState(0);
  return (
    <div className="kb-page" data-width="wide">
      <PageHeader title={t('ia_shell_work_title')} subtitle={t('ia_shell_work_subtitle')}>
        <Button
          label={planning ? t('ia_shell_work_plan_close') : t('ia_shell_work_plan_open')}
          variant={planning ? 'secondary' : 'primary'}
          onClick={() => setPlanning((open) => !open)}
        />
      </PageHeader>
      {planning ? (
        <div className="work-plan">
          <MissionPlanPanel
            t={(key, params) => t(key as Parameters<typeof t>[0], params)}
            locale={locale}
            onStarted={() => setListRevision((value) => value + 1)}
          />
        </div>
      ) : null}
      <DestinationTabs
        label={t('ia_shell_tabs_label')}
        active={tab}
        tabs={[
          { id: 'missions', label: t('ia_shell_work_tab_missions') },
          { id: 'items', label: t('ia_shell_work_tab_items') },
          { id: 'requests', label: t('ia_shell_work_tab_requests') },
        ]}
      />
      {tab === 'requests' ? (
        <RequestsPanel />
      ) : tab === 'items' ? (
        <KindList key="items" t={t} kind="work_item" embedded />
      ) : (
        <KindList key={`missions-${listRevision}`} t={t} kind="mission" embedded />
      )}
    </div>
  );
}
