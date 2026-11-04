'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@agent/shared-ui';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { IA_WORK_TABS, resolveIaTab, type IaWorkTab } from '../../lib/ia-routes';
import { DestinationTabs } from '../destination-tabs';
import { KindList } from '../w/kind-list';

/**
 * `/work` 仕事 (MSN-SHELL-IA §1): missions as a state board plus their list,
 * and the work-item kanban. Replaces `/w/mission`, `/w/work_item` and the
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
  const { t } = useConciergeI18n();
  const searchParams = useSearchParams();
  const tab = resolveIaTab<IaWorkTab>(IA_WORK_TABS, searchParams?.get('tab') ?? null);
  return (
    <div className="kb-page" data-width="wide">
      <PageHeader title={t('ia_shell_work_title')} subtitle={t('ia_shell_work_subtitle')} />
      <DestinationTabs
        label={t('ia_shell_tabs_label')}
        active={tab}
        tabs={[
          { id: 'missions', label: t('ia_shell_work_tab_missions') },
          { id: 'items', label: t('ia_shell_work_tab_items') },
        ]}
      />
      {tab === 'items' ? (
        <KindList key="items" t={t} kind="work_item" embedded />
      ) : (
        <KindList key="missions" t={t} kind="mission" embedded />
      )}
    </div>
  );
}
