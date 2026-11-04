'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { EmptyState } from '@agent/shared-ui';
import { useConciergeI18n } from '../../../lib/use-concierge-i18n';
import { decodeRouteSegment, isWorkspaceKind } from '../../../lib/workspace-view';
import { WorkspaceCrumbs } from '../workspace-parts';
import { KindList } from '../kind-list';
import '../workspace.css';

/**
 * `/w/<kind>` — kept for unknown kinds and direct client navigation; every
 * known list kind 308-redirects to its destination tab (`lib/ia-routes.ts`).
 */
export default function WorkspaceListPage() {
  return (
    <React.Suspense fallback={null}>
      <WorkspaceList />
    </React.Suspense>
  );
}

function WorkspaceList() {
  const { t } = useConciergeI18n();
  const params = useParams<{ kind: string }>();
  const kind = decodeRouteSegment(params?.kind);
  if (!isWorkspaceKind(kind)) {
    return (
      <div className="ws-page">
        <WorkspaceCrumbs t={t} lineage={[]} />
        <EmptyState
          title={t('ws_error_title')}
          action={{ label: t('ws_overview_title'), href: '/' }}
        />
      </div>
    );
  }
  return <KindList t={t} kind={kind} />;
}
