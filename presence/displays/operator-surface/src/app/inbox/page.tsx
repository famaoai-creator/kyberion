import { listInboxEntries } from '@agent/core/deliverable-inbox';
import { Section, StatusPill } from '@agent/shared-ui';
import type { KbStatus } from '@agent/core/a2ui-catalog';
import { emitMosRead } from '@/lib/audit-mos';
import { operatorTranslator } from '@/lib/i18n';
import { getRequestLocale } from '@/lib/request-locale';
import { formatTimestamp } from '@/lib/view';
import { DataTable, type DataTableRow } from '@/components/DataTable';
import { OperatorPageHeader } from '../operator-shell';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const entries = listInboxEntries({ limit: 100 });
  emitMosRead({ page: '/inbox', resource_kind: 'deliverable_inbox', result_count: entries.length });
  const locale = await getRequestLocale();
  const t = operatorTranslator(locale);
  const statusPill = (status: string): { status: KbStatus; label: string } => {
    if (status === 'unread') return { status: 'pending', label: t('inbox_status_unread') };
    if (status === 'read') return { status: 'review', label: t('inbox_status_read') };
    if (status === 'accepted') return { status: 'done', label: t('inbox_status_accepted') };
    return { status: 'n/a', label: status || '—' };
  };

  const rows: DataTableRow[] = entries.map((entry) => {
    const pill = statusPill(entry.status);
    return {
      id: entry.entry_id,
      cells: {
        entry: <span className="operator-mono">{entry.entry_id}</span>,
        mission: <span className="operator-mono">{entry.mission_id ?? '—'}</span>,
        status: <StatusPill status={pill.status} label={pill.label} />,
        summary: (
          <span className="operator-cell">
            <span className="operator-cell__title">{entry.title}</span>
            <span className="operator-cell__meta">{entry.summary || '—'}</span>
          </span>
        ),
        updated: formatTimestamp(entry.updated_at, locale),
        action: (
          // The single governed write of this surface (see test/no-write-api):
          // marking a deliverable as accepted through /api/inbox.
          <form action="/api/inbox" method="post">
            <input type="hidden" name="entry_id" value={entry.entry_id} />
            <input type="hidden" name="status" value="accepted" />
            <button type="submit" className="kb-btn kb-btn--secondary">
              {t('inbox_accept')}
            </button>
          </form>
        ),
      },
    };
  });

  return (
    <>
      <OperatorPageHeader title={t('inbox_title')} subtitle={t('inbox_subtitle')} />
      <Section>
        <DataTable
          columns={[
            { key: 'entry', label: t('col_entry') },
            { key: 'mission', label: t('col_mission') },
            { key: 'status', label: t('col_status') },
            { key: 'summary', label: t('col_summary') },
            { key: 'updated', label: t('col_updated') },
            { key: 'action', label: t('col_action') },
          ]}
          rows={rows}
          empty={t('inbox_empty')}
        />
      </Section>
    </>
  );
}
