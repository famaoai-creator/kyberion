import { listMissions, getCapabilities, getProviderPins } from '@/lib/data';
import { emitMosRead } from '@/lib/audit-mos';
import CapabilityDashboard from '@/components/CapabilityDashboard';
import { renderStatus } from '@agent/core';

export const dynamic = 'force-dynamic';

export default async function MissionsPage() {
  const missions = listMissions();
  const bundles = getCapabilities();
  const pins = getProviderPins();
  emitMosRead({ page: '/', resource_kind: 'mission_list', result_count: missions.length });
  return (
    <section>
      <h1 style={{ marginBottom: '4px' }}>Missions</h1>
      <p style={{ color: 'var(--kb-muted-text)', marginTop: 0 }}>
        Filtered by the operator's <code>KYBERION_TENANT</code>. Click a row to inspect its
        evidence, history, and checkpoints. Read-only.
      </p>
      {missions.length === 0 ? (
        <p style={{ color: 'var(--kb-muted-text)' }}>No missions visible to this tenant scope.</p>
      ) : (
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '14px',
            marginTop: '12px',
          }}
        >
          <thead>
            <tr style={{ background: 'var(--kb-surface)', textAlign: 'left' }}>
              <th style={th}>Mission ID</th>
              <th style={th}>Status</th>
              <th style={th}>Tier</th>
              <th style={th}>Tenant</th>
              <th style={th}>Persona</th>
              <th style={th}>Checkpoints</th>
              <th style={th}>Latest commit</th>
            </tr>
          </thead>
          <tbody>
            {missions.map((m) => (
              <tr key={m.mission_id} style={{ borderBottom: '1px solid var(--kb-border)' }}>
                <td style={td}>
                  <a
                    href={`/missions/${encodeURIComponent(m.mission_id)}`}
                    style={{ color: 'var(--kb-accent-text)' }}
                  >
                    {m.mission_id}
                  </a>
                </td>
                <td style={td}>{statusBadge(m.status)}</td>
                <td style={td}>
                  <code>{m.tier}</code>
                </td>
                <td style={td}>
                  <code>{m.tenant_slug ?? '—'}</code>
                </td>
                <td style={td}>{m.assigned_persona ?? '—'}</td>
                <td style={td}>{m.checkpoints_count ?? 0}</td>
                <td style={td}>
                  <code style={{ color: 'var(--kb-muted-text)' }}>{m.latest_commit ?? '—'}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Capability and Pin Control Dashboard */}
      <CapabilityDashboard bundles={bundles} pins={pins} />
    </section>
  );
}

const th: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid var(--kb-border)',
  fontWeight: 600,
};
const td: React.CSSProperties = { padding: '8px 12px', verticalAlign: 'top' };

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    active: 'var(--kb-success)',
    completed: 'var(--kb-muted-text)',
    failed: 'var(--kb-danger)',
    paused: 'var(--kb-warning)',
    planned: 'var(--kb-accent-text)',
    archived: 'var(--kb-muted-text)',
    distilling: 'var(--kb-accent)',
  };
  return (
    <span
      style={{
        color: colors[status] ?? 'var(--kb-text-primary)',
        fontFamily: 'ui-monospace, monospace',
        fontSize: '12px',
      }}
    >
      {renderStatus('mission', status, 'en')}
    </span>
  );
}
