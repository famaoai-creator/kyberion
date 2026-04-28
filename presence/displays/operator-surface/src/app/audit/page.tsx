import { listRecentAuditEvents, getTenantScope } from '@/lib/data';
import { emitMosRead } from '@/lib/audit-mos';

export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  const events = listRecentAuditEvents(200);
  emitMosRead({ page: '/audit', resource_kind: 'audit', result_count: events.length });
  const scope = getTenantScope();
  return (
    <section>
      <h1 style={{ marginBottom: 4 }}>Audit Chain</h1>
      <p style={{ color: '#9aa0aa', marginTop: 0, fontSize: 13 }}>
        Most recent {events.length} events
        {scope ? <> filtered to tenant <code>{scope}</code></> : null}.
        Source: <code>active/audit/*.jsonl</code>. Hash chain integrity is
        verified at write time; this page renders raw entries.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#15171c', textAlign: 'left' }}>
            <th style={th}>Time</th>
            <th style={th}>Action</th>
            <th style={th}>Operation</th>
            <th style={th}>Result</th>
            <th style={th}>Tenant</th>
            <th style={th}>Mission</th>
            <th style={th}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} style={{ borderBottom: '1px solid #1a1c22' }}>
              <td style={td}>{e.timestamp?.slice(0, 19)}</td>
              <td style={td}>
                <code>{e.action}</code>
              </td>
              <td style={td}>
                <code style={{ color: '#9aa0aa' }}>{e.operation}</code>
              </td>
              <td style={td}>{resultBadge(e.result)}</td>
              <td style={td}>
                <code>{e.tenantSlug ?? '—'}</code>
              </td>
              <td style={td}>
                <code>{e.mission_id ?? '—'}</code>
              </td>
              <td style={{ ...td, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {e.reason ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const th: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #2a2c33', fontWeight: 600 };
const td: React.CSSProperties = { padding: '6px 12px', verticalAlign: 'top' };

function resultBadge(result: string) {
  const colors: Record<string, string> = {
    allowed: '#9be3a8',
    denied: '#ff8fa3',
    error: '#ff8fa3',
    completed: '#8ec3ff',
    failed: '#ff8fa3',
  };
  return <code style={{ color: colors[result] ?? '#e4e6eb' }}>{result || '—'}</code>;
}
