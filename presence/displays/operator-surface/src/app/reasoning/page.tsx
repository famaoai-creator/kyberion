import { inspectReasoningRoutes } from '@agent/core';
import { emitMosRead } from '@/lib/audit-mos';

export const dynamic = 'force-dynamic';

export default async function ReasoningPage() {
  const report = await inspectReasoningRoutes();
  emitMosRead({
    page: '/reasoning',
    resource_kind: 'reasoning_routes',
    result_count: report.entries.length,
  });
  return (
    <section>
      <h1 style={{ marginBottom: 4 }}>Reasoning routes</h1>
      <p style={{ color: 'var(--kb-muted-text)', marginTop: 0, fontSize: 13 }}>
        Read-only route, capability, and runtime readiness view. Probes do not consume completion
        tokens.
      </p>
      <div style={{ display: 'flex', gap: 12, margin: '16px 0' }}>
        <Status
          label="Configuration"
          value={
            !report.valid
              ? 'needs attention'
              : report.entries.some((entry) => entry.status === 'degraded')
                ? 'degraded fallback'
                : 'ready'
          }
        />
        <Status label="Checked" value={new Date(report.checkedAt).toLocaleTimeString()} />
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'var(--kb-surface)', textAlign: 'left' }}>
            <th style={th}>Role</th>
            <th style={th}>Selected</th>
            <th style={th}>Runtime</th>
            <th style={th}>Model</th>
            <th style={th}>Status</th>
            <th style={th}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {report.entries.map((entry) => (
            <tr key={entry.role} style={{ borderBottom: '1px solid var(--kb-border)' }}>
              <td style={td}>
                <code>{entry.role}</code>
              </td>
              <td style={td}>
                <code>{entry.profileRef ?? '—'}</code>
              </td>
              <td style={td}>{entry.mode ?? '—'}</td>
              <td style={td}>
                <code>{entry.model ?? '(provider default)'}</code>
              </td>
              <td style={{ ...td, color: statusColor(entry.status) }}>{entry.status}</td>
              <td style={td}>{entry.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {report.nextActions.length > 0 ? (
        <>
          <h2 style={{ marginTop: 28 }}>Next actions</h2>
          <ul style={{ color: 'var(--kb-muted-text)', fontSize: 13 }}>
            {report.nextActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function Status({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--kb-surface)', padding: '10px 14px', borderRadius: 4 }}>
      <div style={{ fontSize: 11, color: 'var(--kb-muted-text)' }}>{label}</div>
      <strong>{value}</strong>
    </div>
  );
}

function statusColor(status: string): string {
  return status === 'ready'
    ? 'var(--kb-success)'
    : status === 'invalid'
      ? 'var(--kb-danger)'
      : 'var(--kb-warning)';
}

const th: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid var(--kb-border)' };
const td: React.CSSProperties = { padding: '8px 12px', verticalAlign: 'top' };
