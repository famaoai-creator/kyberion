import { getHealthSummary, getTenantScope } from '@/lib/data';
import { emitMosRead } from '@/lib/audit-mos';

export const dynamic = 'force-dynamic';

export default async function HealthPage() {
  const h = getHealthSummary();
  const scope = getTenantScope();
  emitMosRead({ page: '/health', resource_kind: 'health' });
  return (
    <section>
      <h1 style={{ marginBottom: 4 }}>Health</h1>
      <p style={{ color: 'var(--kb-muted-text)', marginTop: 0, fontSize: 13 }}>
        Mission counts and recent audit volume
        {scope ? (
          <>
            {' '}
            for tenant <code>{scope}</code>
          </>
        ) : null}
        . Refreshes on each navigation; no polling.
      </p>
      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 12 }}
      >
        <Card label="Active missions" value={h.active_missions} accent="var(--kb-success)" />
        <Card label="Completed" value={h.completed_missions} accent="var(--kb-accent-text)" />
        <Card label="Failed" value={h.failed_missions} accent="var(--kb-danger)" />
        <Card
          label="Audit events (24h)"
          value={h.recent_audit_events_24h}
          accent="var(--kb-accent)"
        />
        <Card
          label="Rubric overrides (lifetime)"
          value={h.recent_override_events}
          accent="var(--kb-warning)"
        />
      </div>

      <h2 style={{ marginTop: 28 }}>Health-related commands</h2>
      <ul style={{ fontSize: 13, fontFamily: 'ui-monospace, monospace' }}>
        <li>
          <code>pnpm pipeline --input pipelines/baseline-check.json</code>
        </li>
        <li>
          <code>pnpm pipeline --input pipelines/full-health-report.json</code>
        </li>
        <li>
          <code>pnpm watch:tenant-drift</code>
        </li>
        <li>
          <code>pnpm run check:contract-schemas</code>
        </li>
      </ul>
    </section>
  );
}

function Card({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div
      style={{
        background: 'var(--kb-surface)',
        borderLeft: `3px solid ${accent}`,
        padding: '12px 16px',
        borderRadius: 4,
      }}
    >
      <div style={{ fontSize: 28, fontWeight: 600, color: accent }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--kb-muted-text)', marginTop: 4 }}>{label}</div>
    </div>
  );
}
