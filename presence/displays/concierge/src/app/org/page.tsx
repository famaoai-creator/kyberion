'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PageHeader } from '@agent/shared-ui';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { useShellScope } from '../../lib/shell-scope';
import { withSelectedTenant } from '../../lib/tenant-context';
import { IA_ORG_TABS, resolveIaTab, type IaOrgTab } from '../../lib/ia-routes';
import { OrganizationOperatingModel } from '../../components/ops/OrganizationOperatingModel';
import { DestinationTabs } from '../destination-tabs';
import { KindList } from '../w/kind-list';
// The operating model is a console component: its stylesheet is scoped to `.kb-ops`.
import '../ops/globals.css';

/**
 * `/org` 組織 (MSN-SHELL-IA §1): the operating model (objectives, key results,
 * interventions, services), projects, and people & agents. Replaces
 * `/w/organization`, `/w/tenant`, `/w/project`, `/w/actor` and the console's
 * organization section; editing stays at `/management`, linked from here.
 * The scope comes from the shell switcher only.
 */
export default function OrgPage() {
  return (
    <React.Suspense fallback={null}>
      <Org />
    </React.Suspense>
  );
}

function Org() {
  const { t } = useConciergeI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const scope = useShellScope();
  const tab = resolveIaTab<IaOrgTab>(IA_ORG_TABS, searchParams?.get('tab') ?? null);
  const editHref = withSelectedTenant('/management', scope.tenant || null);
  return (
    <div className="kb-page" data-width="wide">
      <PageHeader
        title={t('ia_shell_org_title')}
        subtitle={t('ia_shell_org_subtitle')}
        actions={[{ label: t('ia_shell_org_edit'), href: editHref }]}
      />
      <DestinationTabs
        label={t('ia_shell_tabs_label')}
        active={tab}
        tabs={[
          { id: 'overview', label: t('ia_shell_org_tab_overview') },
          { id: 'projects', label: t('ia_shell_org_tab_projects') },
          { id: 'people', label: t('ia_shell_org_tab_people') },
        ]}
      />
      {tab === 'projects' ? (
        <KindList key="projects" t={t} kind="project" embedded />
      ) : tab === 'people' ? (
        <KindList key="people" t={t} kind="actor" embedded />
      ) : (
        <div className="kb-ops">
          <OrganizationOperatingModel
            key={`${scope.tenant}:${scope.organizationId}:${scope.projectId}`}
            tenant={scope.tenant || undefined}
            organizationId={scope.organizationId || undefined}
            projectId={scope.projectId || undefined}
            onOpenOperations={() =>
              router.push(withSelectedTenant('/ops?section=operations', scope.tenant || null))
            }
            onOpenGovernance={() => router.push(withSelectedTenant('/inbox', scope.tenant || null))}
          />
        </div>
      )}
    </div>
  );
}
