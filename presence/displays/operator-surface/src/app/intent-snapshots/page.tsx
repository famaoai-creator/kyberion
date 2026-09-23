import Link from 'next/link';
import {
  Badge,
  Disclosure,
  EmptyState,
  KeyValue,
  List,
  Section,
  StatusPill,
} from '@agent/shared-ui';
import type { KbStatus } from '@agent/core/a2ui-catalog';
import {
  renderIntentAuthorityLabel,
  renderIntentOutcomeLabel,
  resolveIntentResolutionContract,
  type IntentResolutionContract,
} from '@agent/core/intent-resolution-contract';
import { emitMosRead } from '@/lib/audit-mos';
import { getTenantScope, listIntentSnapshotRows } from '@/lib/data';
import { operatorTranslator, type OperatorLocale, type OperatorTranslate } from '@/lib/i18n';
import { getRequestLocale } from '@/lib/request-locale';
import { formatTimestamp, tierLabel, tierTone } from '@/lib/view';
import { OperatorPageHeader } from '../operator-shell';

export const dynamic = 'force-dynamic';

type SnapshotRow = ReturnType<typeof listIntentSnapshotRows>[number];

export default async function IntentSnapshotsPage() {
  const scope = getTenantScope();
  const rows = listIntentSnapshotRows({ tenantScope: scope, limit: 100 });
  emitMosRead({
    page: '/intent-snapshots',
    resource_kind: 'intent_snapshots',
    result_count: rows.length,
  });
  const locale = await getRequestLocale();
  const t = operatorTranslator(locale);

  return (
    <>
      <OperatorPageHeader
        title={t('intent_title')}
        subtitle={scope ? t('intent_subtitle_scoped', { tenant: scope }) : t('intent_subtitle')}
      />
      {rows.length === 0 ? (
        <EmptyState title={t('intent_empty')} />
      ) : (
        <Section title={t('intent_list_title', { count: rows.length })}>
          {rows.map((row) => (
            <article key={row.snapshot.snapshot_id} className="operator-card">
              <div className="operator-card__header">
                <span className="operator-cell">
                  <Link
                    href={`/missions/${encodeURIComponent(row.mission_id)}`}
                    className="operator-cell__title operator-mono"
                  >
                    {row.mission_id}
                  </Link>
                  <span className="operator-cell__meta operator-mono">
                    {row.snapshot.stage} · {row.snapshot.kind ?? 'current'} · {row.snapshot.source}
                  </span>
                </span>
                <span className="operator-chips">
                  <Badge label={tierLabel(row.tier, t)} tone={tierTone(row.tier)} />
                  <Badge label={row.tenant_slug ?? 'public'} tone="neutral" />
                  <span className="operator-cell__meta">
                    {formatTimestamp(row.snapshot.created_at, locale)}
                  </span>
                </span>
              </div>
              <p className="kb-text kb-text--body">{row.snapshot.intent.goal}</p>
              <IntentResolutionSummary row={row} locale={locale} t={t} />
              {row.delta ? (
                <DeltaSummary row={row} t={t} />
              ) : (
                <p className="kb-text kb-text--caption">{t('intent_origin_snapshot')}</p>
              )}
            </article>
          ))}
        </Section>
      )}
    </>
  );
}

/** Resolution contract of the snapshot's goal (IL contract renderer). */
function IntentResolutionSummary({
  row,
  locale,
  t,
}: {
  row: SnapshotRow;
  locale: OperatorLocale;
  t: OperatorTranslate;
}) {
  let contract: IntentResolutionContract | undefined;
  try {
    contract = resolveIntentResolutionContract(row.snapshot.intent.goal, {
      tier: row.tier,
      tenantId: row.tenant_slug,
    });
  } catch {
    contract = undefined;
  }
  if (!contract) return null;

  return (
    <Disclosure summary={t('intent_resolution_contract')}>
      <KeyValue
        items={[
          { label: t('intent_understanding'), value: contract.normalized_intent },
          {
            label: t('intent_missing_input'),
            value:
              contract.missing_inputs.length > 0
                ? contract.missing_inputs.join(', ')
                : t('value_none'),
          },
          {
            label: t('intent_authority'),
            value: renderIntentAuthorityLabel(contract.authority_level, locale),
          },
          { label: t('intent_next_action'), value: contract.next_action.label },
          {
            label: t('intent_outcome'),
            value: renderIntentOutcomeLabel(contract.outcome_kind, locale),
          },
          { label: t('intent_consequence'), value: contract.next_action.consequence },
        ]}
      />
    </Disclosure>
  );
}

function driftStatus(verdict: string | undefined): KbStatus {
  if (verdict === 'blocking') return 'blocked';
  if (verdict === 'significant') return 'degraded';
  if (verdict === 'none') return 'ready';
  return 'n/a';
}

function DeltaSummary({ row, t }: { row: SnapshotRow; t: OperatorTranslate }) {
  const changes = Object.entries(row.delta?.changes ?? {}).filter(
    ([key, value]) => key !== 'goal_similarity' && value
  );
  const verdict = row.delta?.drift_verdict;
  return (
    <div className="operator-cell">
      <span className="operator-chips">
        <StatusPill
          status={driftStatus(verdict)}
          label={t('intent_drift', { verdict: String(verdict ?? '—') })}
        />
        <span className="operator-cell__meta">
          {t('intent_drift_score', {
            score: String(row.delta?.drift_score ?? '—'),
            previous: String(row.previous_snapshot_id ?? '—'),
          })}
        </span>
      </span>
      {changes.length > 0 ? (
        <List items={changes.map(([key, value]) => ({ title: key, meta: formatChange(value) }))} />
      ) : (
        <p className="kb-text kb-text--caption">{t('intent_no_field_changes')}</p>
      )}
    </div>
  );
}

function formatChange(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}
