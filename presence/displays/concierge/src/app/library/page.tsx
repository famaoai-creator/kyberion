'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@agent/shared-ui';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { useShellScope } from '../../lib/shell-scope';
import { withSelectedTenant } from '../../lib/tenant-context';
import { IA_LIBRARY_TABS, resolveIaTab, type IaLibraryTab } from '../../lib/ia-routes';
import { DeliverablesWorkspace } from '../../components/ops/DeliverablesWorkspace';
import { KnowledgeWorkspace } from '../../components/ops/KnowledgeWorkspace';
import { DestinationTabs } from '../destination-tabs';
import { IngestPanel } from './ingest-panel';
// The deliverable / knowledge browsers are console components scoped to `.kb-ops`.
import '../ops/globals.css';

/**
 * `/library` 資料 (MSN-SHELL-IA §1): delivered artifacts and knowledge to
 * browse, and document intake. Decisions about either (accept a deliverable,
 * approve a knowledge candidate) live only in あなた待ち (`/inbox`), so this
 * page links there instead of repeating the decision UI. Replaces the
 * console's deliverables / knowledge sections and `/ingest`.
 */
export default function LibraryPage() {
  return (
    <React.Suspense fallback={null}>
      <Library />
    </React.Suspense>
  );
}

function Library() {
  const { t } = useConciergeI18n();
  const searchParams = useSearchParams();
  const scope = useShellScope();
  const tab = resolveIaTab<IaLibraryTab>(IA_LIBRARY_TABS, searchParams?.get('tab') ?? null);
  const inboxHref = (reason: string) =>
    withSelectedTenant(`/inbox?reason=${reason}`, scope.tenant || null);
  return (
    <div className="kb-page" data-width={tab === 'ingest' ? 'form' : 'wide'}>
      <PageHeader title={t('ia_shell_library_title')} subtitle={t('ia_shell_library_subtitle')} />
      <DestinationTabs
        label={t('ia_shell_tabs_label')}
        active={tab}
        tabs={[
          { id: 'deliverables', label: t('ia_shell_library_tab_deliverables') },
          { id: 'knowledge', label: t('ia_shell_library_tab_knowledge') },
          { id: 'ingest', label: t('ia_shell_library_tab_ingest') },
        ]}
      />
      {tab === 'ingest' ? (
        <IngestPanel />
      ) : tab === 'knowledge' ? (
        <div className="kb-ops">
          <KnowledgeWorkspace
            key={`${scope.tenant}:${scope.organizationId}:${scope.projectId}`}
            tenant={scope.tenant || undefined}
            organizationId={scope.organizationId || undefined}
            projectId={scope.projectId || undefined}
            browseOnly={{
              href: inboxHref('knowledge'),
              title: t('ia_shell_library_knowledge_where'),
              label: t('ia_shell_open_inbox'),
            }}
          />
        </div>
      ) : (
        <div className="kb-ops">
          <DeliverablesWorkspace
            key={`${scope.tenant}:${scope.organizationId}:${scope.projectId}`}
            tenant={scope.tenant || undefined}
            organizationId={scope.organizationId || undefined}
            projectId={scope.projectId || undefined}
            browseOnly={{
              href: inboxHref('review'),
              title: t('ia_shell_library_review_where'),
              label: t('ia_shell_open_inbox'),
            }}
          />
        </div>
      )}
    </div>
  );
}
