import Link from 'next/link';
import {
  renderIntentAuthorityLabel,
  renderIntentOutcomeLabel,
  resolveIntentResolutionContract,
  type IntentResolutionContract,
} from '@agent/core/intent-resolution-contract';
import { emitMosRead } from '@/lib/audit-mos';
import { getTenantScope, listIntentSnapshotRows } from '@/lib/data';

export const dynamic = 'force-dynamic';

export default function IntentSnapshotsPage() {
  const scope = getTenantScope();
  const rows = listIntentSnapshotRows({ tenantScope: scope, limit: 100 });
  emitMosRead({
    page: '/intent-snapshots',
    resource_kind: 'intent_snapshots',
    result_count: rows.length,
  });

  return (
    <section>
      <h1 style={{ marginBottom: 4 }}>Intent Snapshots</h1>
      <p style={{ color: 'var(--kb-muted-text)', marginTop: 0, fontSize: 13 }}>
        Read-only history of the intent captured at each mission stage
        {scope ? (
          <>
            {' '}
            for tenant <code>{scope}</code>
          </>
        ) : null}
        . Deltas compare each snapshot with the immediately preceding snapshot in the same mission.
      </p>
      <p style={{ marginTop: 8 }}>
        <Link href="/" style={{ color: 'var(--kb-accent-text)' }}>
          Back to missions
        </Link>
      </p>
      {rows.length === 0 ? (
        <p style={{ color: 'var(--kb-muted-text)' }}>
          No intent snapshots are visible to this scope.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
          {rows.map((row) => (
            <article key={row.snapshot.snapshot_id} style={cardStyle}>
              <IntentResolutionSummary row={row} />
              <div style={headerStyle}>
                <div>
                  <Link
                    href={`/missions/${encodeURIComponent(row.mission_id)}`}
                    style={{ color: 'var(--kb-accent-text)' }}
                  >
                    <strong>{row.mission_id}</strong>
                  </Link>
                  <div style={metaStyle}>
                    <code>{row.tier}</code> · <code>{row.tenant_slug ?? 'public'}</code> ·{' '}
                    <code>{row.snapshot.stage}</code> ·{' '}
                    <code>{row.snapshot.kind ?? 'current'}</code> ·{' '}
                    <code>{row.snapshot.source}</code>
                  </div>
                </div>
                <code style={metaStyle}>{row.snapshot.created_at}</code>
              </div>
              <p style={{ marginBottom: 8 }}>{row.snapshot.intent.goal}</p>
              {row.delta ? (
                <DeltaSummary row={row} />
              ) : (
                <div style={metaStyle}>Origin snapshot; no preceding snapshot.</div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function IntentResolutionSummary({
  row,
}: {
  row: ReturnType<typeof listIntentSnapshotRows>[number];
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
    <section style={intentResolutionStyle} aria-label="Intent resolution contract">
      <div style={intentResolutionTitleStyle}>Resolution contract</div>
      <div style={intentResolutionGridStyle}>
        <div>
          <span style={intentResolutionLabelStyle}>Understanding</span>
          <strong>{contract.normalized_intent}</strong>
        </div>
        <div>
          <span style={intentResolutionLabelStyle}>Missing input</span>
          <strong>
            {contract.missing_inputs.length > 0 ? contract.missing_inputs.join(', ') : 'None'}
          </strong>
        </div>
        <div>
          <span style={intentResolutionLabelStyle}>Authority</span>
          <strong>{renderIntentAuthorityLabel(contract.authority_level, 'en')}</strong>
        </div>
        <div>
          <span style={intentResolutionLabelStyle}>Next action</span>
          <strong>{contract.next_action.label}</strong>
        </div>
        <div>
          <span style={intentResolutionLabelStyle}>Outcome</span>
          <strong>{renderIntentOutcomeLabel(contract.outcome_kind, 'en')}</strong>
        </div>
      </div>
      <div style={intentResolutionConsequenceStyle}>{contract.next_action.consequence}</div>
    </section>
  );
}

function DeltaSummary({ row }: { row: ReturnType<typeof listIntentSnapshotRows>[number] }) {
  const changes = Object.entries(row.delta?.changes ?? {}).filter(
    ([key, value]) => key !== 'goal_similarity' && value
  );
  return (
    <details>
      <summary style={{ cursor: 'pointer', color: deltaColor(row.delta?.drift_verdict) }}>
        Drift: {row.delta?.drift_verdict} · score {row.delta?.drift_score} · previous{' '}
        {row.previous_snapshot_id}
      </summary>
      {changes.length > 0 ? (
        <ul style={{ marginBottom: 0, color: 'var(--kb-muted-text)', fontSize: 12 }}>
          {changes.map(([key, value]) => (
            <li key={key}>
              <code>{key}</code>: {formatChange(value)}
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ color: 'var(--kb-muted-text)', fontSize: 12 }}>No field changes.</p>
      )}
    </details>
  );
}

function formatChange(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function deltaColor(verdict?: string): string {
  return verdict === 'blocking'
    ? 'var(--kb-danger)'
    : verdict === 'significant'
      ? 'var(--kb-warning)'
      : 'var(--kb-text-secondary)';
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
};
const metaStyle: React.CSSProperties = {
  color: 'var(--kb-muted-text)',
  fontSize: 12,
  marginTop: 4,
};
const cardStyle: React.CSSProperties = {
  background: 'var(--kb-surface)',
  border: '1px solid var(--kb-border)',
  borderRadius: 8,
  padding: '14px 16px',
};
const intentResolutionStyle: React.CSSProperties = {
  marginBottom: 12,
  padding: '10px 12px',
  border: '1px solid var(--kb-border)',
  borderRadius: 8,
  background: 'var(--kb-surface-raised, var(--kb-surface))',
};
const intentResolutionTitleStyle: React.CSSProperties = {
  color: 'var(--kb-muted-text)',
  fontSize: 11,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
};
const intentResolutionGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
  gap: 10,
  marginTop: 8,
};
const intentResolutionLabelStyle: React.CSSProperties = {
  display: 'block',
  color: 'var(--kb-muted-text)',
  fontSize: 11,
  marginBottom: 3,
};
const intentResolutionConsequenceStyle: React.CSSProperties = {
  color: 'var(--kb-muted-text)',
  fontSize: 12,
  marginTop: 8,
};
