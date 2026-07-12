import {
  buildSurfaceLauncherRecommendations,
  getSurfaceDirectory,
  getSurfaceDirectorySummary,
  getSurfaceScenarioGuide,
  getTenantScope,
} from '@/lib/data';
import { emitMosRead } from '@/lib/audit-mos';
import { renderStatus } from '@agent/core';

export const dynamic = 'force-dynamic';

const authColors: Record<string, string> = {
  ready: 'var(--kb-success)',
  missing: 'var(--kb-danger)',
  'n/a': 'var(--kb-muted-text)',
};

const runtimeColors: Record<string, string> = {
  running: 'var(--kb-success)',
  stale: 'var(--kb-warning)',
  stopped: 'var(--kb-muted-text)',
};

export default async function SurfacesPage() {
  const rows = getSurfaceDirectory();
  const summary = getSurfaceDirectorySummary();
  const scenarios = getSurfaceScenarioGuide();
  const recommendations = buildSurfaceLauncherRecommendations({ rows });
  const scope = getTenantScope();
  emitMosRead({ page: '/surfaces', resource_kind: 'surface_directory', result_count: rows.length });

  return (
    <section>
      <h1 style={{ marginBottom: 4 }}>Surfaces</h1>
      <p style={{ color: 'var(--kb-muted-text)', marginTop: 0, fontSize: 13 }}>
        Read-only surface concierge for auth, runtime state, and scenario fit
        {scope ? (
          <>
            {' '}
            in tenant scope <code>{scope}</code>
          </>
        ) : null}
        .
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 12,
          marginTop: 12,
        }}
      >
        <StatCard label="Managed surfaces" value={summary.total} accent="var(--kb-accent-text)" />
        <StatCard label="Enabled" value={summary.enabled} accent="var(--kb-success)" />
        <StatCard label="Auth required" value={summary.auth_required} accent="var(--kb-warning)" />
        <StatCard label="Auth missing" value={summary.auth_missing} accent="var(--kb-danger)" />
        <StatCard label="Stale runtimes" value={summary.stale} accent="var(--kb-accent)" />
        <StatCard label="Blocked surfaces" value={summary.blocked} accent="var(--kb-warning)" />
      </div>

      <h2 style={{ marginTop: 28, marginBottom: 12 }}>Scenario guide</h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 12,
        }}
      >
        {scenarios.map((scenario) => (
          <article
            key={scenario.id}
            style={{
              background: 'var(--kb-surface)',
              border: '1px solid var(--kb-border)',
              borderRadius: 8,
              padding: '14px 16px',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 8,
                alignItems: 'baseline',
              }}
            >
              <strong>{scenario.title}</strong>
              <code style={{ color: 'var(--kb-accent-text)', fontSize: 11 }}>
                {scenario.surface_ids.join(', ')}
              </code>
            </div>
            <p style={{ color: 'var(--kb-text-secondary)', fontSize: 13, marginBottom: 6 }}>
              {scenario.summary}
            </p>
            <p style={{ color: 'var(--kb-muted-text)', fontSize: 12, margin: 0 }}>
              {scenario.guidance}
            </p>
          </article>
        ))}
      </div>

      <h2 style={{ marginTop: 28, marginBottom: 12 }}>Recommended right now</h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 12,
        }}
      >
        {recommendations.map((recommendation) => (
          <article
            key={recommendation.id}
            style={{
              background: 'var(--kb-surface)',
              border: '1px solid var(--kb-border)',
              borderRadius: 8,
              padding: '14px 16px',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 8,
                alignItems: 'baseline',
              }}
            >
              <strong>{recommendation.title}</strong>
              <StatusPill
                text={renderStatus('readiness', recommendation.readiness, 'en')}
                color={
                  recommendation.readiness === 'ready'
                    ? 'var(--kb-success)'
                    : recommendation.readiness === 'needs_setup'
                      ? 'var(--kb-warning)'
                      : 'var(--kb-muted-text)'
                }
              />
            </div>
            <p style={{ color: 'var(--kb-text-secondary)', fontSize: 13, marginBottom: 6 }}>
              {recommendation.whenToUse}
            </p>
            <p style={{ color: 'var(--kb-muted-text)', fontSize: 12, marginTop: 0 }}>
              {recommendation.reason}
            </p>
            <code style={{ color: 'var(--kb-accent-text)', fontSize: 12 }}>
              {recommendation.suggestedCommand}
            </code>
          </article>
        ))}
      </div>

      <h2 style={{ marginTop: 28, marginBottom: 12 }}>Runtime directory</h2>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--kb-surface)', textAlign: 'left' }}>
              <th style={th}>Surface</th>
              <th style={th}>Runtime</th>
              <th style={th}>Auth</th>
              <th style={th}>Use cases</th>
              <th style={th}>Best for / blocked</th>
              <th style={th}>Next command</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} style={{ borderBottom: '1px solid var(--kb-border)' }}>
                <td style={td}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <strong>{row.id}</strong>
                    <span style={{ color: 'var(--kb-muted-text)' }}>{row.description}</span>
                    <span style={{ color: 'var(--kb-muted-text)', fontSize: 12 }}>
                      {row.kind} · {row.startup_mode} · authority <code>{row.authority_role}</code>
                    </span>
                  </div>
                </td>
                <td style={td}>
                  <StatusPill
                    text={renderStatus('runtime', row.runtime_status, 'en')}
                    color={runtimeColors[row.runtime_status]}
                  />
                  <div style={{ color: 'var(--kb-muted-text)', fontSize: 12, marginTop: 6 }}>
                    {row.enabled ? 'enabled' : 'disabled'}
                  </div>
                  <div style={{ color: 'var(--kb-muted-text)', fontSize: 12, marginTop: 6 }}>
                    {row.operator_notes}
                  </div>
                </td>
                <td style={td}>
                  <StatusPill
                    text={`${row.auth_requirement} / ${renderStatus('connection', row.auth_status, 'en')}`}
                    color={authColors[row.auth_status]}
                  />
                  <div style={{ color: 'var(--kb-muted-text)', fontSize: 12, marginTop: 6 }}>
                    strategy: <code>{row.auth_strategy}</code>
                  </div>
                  {row.required_secrets.length > 0 ? (
                    <div style={{ color: 'var(--kb-muted-text)', fontSize: 12, marginTop: 6 }}>
                      secrets: <code>{row.required_secrets.join(', ')}</code>
                    </div>
                  ) : null}
                </td>
                <td style={td}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {row.use_cases.map((useCase) => (
                      <span
                        key={useCase}
                        style={{
                          border: '1px solid var(--kb-border)',
                          borderRadius: 999,
                          padding: '2px 8px',
                          color: 'var(--kb-text-secondary)',
                          fontSize: 11,
                        }}
                      >
                        {useCase}
                      </span>
                    ))}
                  </div>
                </td>
                <td style={td}>
                  <div style={{ color: 'var(--kb-text-secondary)', fontSize: 12 }}>
                    {row.best_for}
                  </div>
                  <div style={{ color: 'var(--kb-muted-text)', fontSize: 12, marginTop: 6 }}>
                    {row.blocked_by.length > 0
                      ? `blocked by: ${row.blocked_by.join(', ')}`
                      : 'blocked by: none'}
                  </div>
                </td>
                <td style={td}>
                  <code style={{ color: 'var(--kb-accent-text)' }}>{row.next_command}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent: string }) {
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

function StatusPill({ text, color }: { text: string; color: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        borderRadius: 999,
        background: 'var(--kb-bg-main)',
        border: `1px solid ${color}55`,
        color,
        fontFamily: 'ui-monospace, monospace',
        fontSize: 11,
      }}
    >
      {text}
    </span>
  );
}

const th: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid var(--kb-border)',
  fontWeight: 600,
};

const td: React.CSSProperties = {
  padding: '12px',
  verticalAlign: 'top',
};
