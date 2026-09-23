import { notFound } from 'next/navigation';
import {
  Badge,
  EmptyState,
  Grid,
  KeyValue,
  List,
  Section,
  StatusPill,
  Table,
} from '@agent/shared-ui';
import { getMissionDetail, suggestedCommand } from '@/lib/data';
import { emitMosRead } from '@/lib/audit-mos';
import { operatorTranslator } from '@/lib/i18n';
import { getRequestLocale } from '@/lib/request-locale';
import {
  formatCount,
  formatTimestamp,
  missionStatus,
  statusText,
  tierLabel,
  tierTone,
} from '@/lib/view';
import { OperatorPageHeader } from '../../operator-shell';

export const dynamic = 'force-dynamic';

const INTENTS = ['verify', 'distill', 'finish', 'export-bundle', 'view-evidence'] as const;

export default async function MissionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = getMissionDetail(id);
  if (!detail) notFound();
  emitMosRead({
    page: `/missions/${id}`,
    resource_kind: 'mission_detail',
    resource_id: detail.mission_id,
  });

  const locale = await getRequestLocale();
  const t = operatorTranslator(locale);
  const pill = missionStatus(detail.status);
  const intentLabel: Record<(typeof INTENTS)[number], string> = {
    verify: t('detail_intent_verify'),
    distill: t('detail_intent_distill'),
    finish: t('detail_intent_finish'),
    'export-bundle': t('detail_intent_export_bundle'),
    'view-evidence': t('detail_intent_view_evidence'),
  };
  // Newest first reads naturally as an audit timeline.
  const history = [...(detail.history ?? [])].reverse();
  const checkpoints = detail.checkpoints ?? [];
  const evidence = detail.evidence_files ?? [];

  return (
    <>
      <OperatorPageHeader title={detail.title} subtitle={detail.mission_id} />

      <div className="operator-chips">
        <StatusPill status={pill.status} domain="mission" label={pill.label} />
        <Badge label={tierLabel(detail.tier, t)} tone={tierTone(detail.tier)} />
        {detail.tenant_slug ? <Badge label={detail.tenant_slug} tone="neutral" /> : null}
      </div>

      <Grid min_column_width="lg" gap="md">
        <Section title={t('detail_overview_title')}>
          <KeyValue
            items={[
              { label: t('col_mission_id'), value: detail.mission_id, mono: true },
              {
                label: t('col_status'),
                value: statusText(detail.status, locale, 'mission') || '—',
              },
              { label: t('col_tier'), value: tierLabel(detail.tier, t) },
              { label: t('col_tenant'), value: detail.tenant_slug ?? '—', mono: true },
              { label: t('col_persona'), value: detail.assigned_persona ?? '—' },
              { label: t('col_mission_type'), value: detail.mission_type ?? '—' },
              {
                label: t('col_latest_commit'),
                value: detail.latest_commit ? detail.latest_commit.slice(0, 12) : '—',
                mono: true,
              },
              {
                label: t('col_checkpoints'),
                value: formatCount(detail.checkpoints_count ?? 0, locale),
              },
            ]}
          />
        </Section>
        <Section
          title={t('detail_history_title', {
            count: formatCount(detail.history_count ?? 0, locale),
          })}
        >
          {history.length > 0 ? (
            <List
              variant="timeline"
              items={history.map((entry) => ({
                title: entry.event,
                meta: entry.note
                  ? `${formatTimestamp(entry.ts, locale)} · ${entry.note}`
                  : formatTimestamp(entry.ts, locale),
              }))}
            />
          ) : (
            <EmptyState title={t('detail_history_empty')} />
          )}
        </Section>
      </Grid>

      <Section title={t('detail_commands_title')} description={t('detail_commands_description')}>
        <Table
          columns={[
            { key: 'intent', label: t('col_intent') },
            { key: 'command', label: t('col_command'), mono: true },
          ]}
          rows={INTENTS.map((intent) => ({
            intent: intentLabel[intent],
            command: suggestedCommand({ intent, missionId: detail.mission_id }),
          }))}
        />
      </Section>

      <Section
        title={t('detail_checkpoints_title', {
          count: formatCount(detail.checkpoints_count ?? 0, locale),
        })}
      >
        <Table
          columns={[
            { key: 'task', label: t('col_task'), mono: true },
            { key: 'commit', label: t('col_commit'), mono: true },
            { key: 'ts', label: t('col_timestamp') },
          ]}
          rows={checkpoints.map((checkpoint) => ({
            task: checkpoint.task_id,
            commit: checkpoint.commit_hash.slice(0, 8),
            ts: formatTimestamp(checkpoint.ts, locale),
          }))}
          empty={t('detail_checkpoints_empty')}
        />
      </Section>

      <Section title={t('detail_evidence_title', { count: formatCount(evidence.length, locale) })}>
        <Table
          columns={[
            { key: 'name', label: t('col_name'), mono: true },
            { key: 'bytes', label: t('col_bytes'), align: 'end' },
            { key: 'modified', label: t('col_modified') },
          ]}
          rows={evidence.map((file) => ({
            name: file.name,
            bytes: formatCount(file.bytes, locale),
            modified: formatTimestamp(file.modified_at, locale),
          }))}
          empty={t('detail_evidence_empty')}
        />
      </Section>
    </>
  );
}
