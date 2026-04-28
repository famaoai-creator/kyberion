import { listMissions } from '@/lib/data';
import { emitMosRead } from '@/lib/audit-mos';

export const dynamic = 'force-dynamic';

export default async function MissionsPage() {
  const missions = listMissions();
  emitMosRead({ page: '/', resource_kind: 'mission_list', result_count: missions.length });
  return (
    <section>
      <h1 style={{ marginBottom: '4px' }}>Missions</h1>
      <p style={{ color: '#9aa0aa', marginTop: 0 }}>
        Filtered by the operator's <code>KYBERION_TENANT</code>. Click a row to
        inspect its evidence, history, and checkpoints. Read-only.
      </p>
      {missions.length === 0 ? (
        <p style={{ color: '#9aa0aa' }}>No missions visible to this tenant scope.</p>
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
            <tr style={{ background: '#15171c', textAlign: 'left' }}>
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
              <tr
                key={m.mission_id}
                style={{ borderBottom: '1px solid #1a1c22' }}
              >
                <td style={td}>
                  <a
                    href={`/missions/${encodeURIComponent(m.mission_id)}`}
                    style={{ color: '#8ec3ff' }}
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
                  <code style={{ color: '#9aa0aa' }}>{m.latest_commit ?? '—'}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const th: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #2a2c33', fontWeight: 600 };
const td: React.CSSProperties = { padding: '8px 12px', verticalAlign: 'top' };

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    active: '#9be3a8',
    completed: '#9aa0aa',
    failed: '#ff8fa3',
    paused: '#ffd57e',
    planned: '#8ec3ff',
    archived: '#5a6068',
    distilling: '#c08eff',
  };
  return (
    <span
      style={{
        color: colors[status] ?? '#e4e6eb',
        fontFamily: 'ui-monospace, monospace',
        fontSize: '12px',
      }}
    >
      {status}
    </span>
  );
}
