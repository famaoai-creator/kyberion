import { listInboxEntries } from '@agent/core';
import Link from 'next/link';
import { emitMosRead } from '@/lib/audit-mos';

export const dynamic = 'force-dynamic';

export default function InboxPage() {
  const entries = listInboxEntries({ limit: 100 });
  emitMosRead({ page: '/inbox', resource_kind: 'deliverable_inbox', result_count: entries.length });

  return (
    <section>
      <h1 style={{ marginBottom: '4px' }}>Inbox</h1>
      <p style={{ color: '#9aa0aa', marginTop: 0 }}>
        Deliverables are collected here as read-only inbox entries. Accepting an item marks it as
        handled and keeps the audit trail local.
      </p>
      <p style={{ marginTop: '8px' }}>
        <Link href="/" style={{ color: '#8ec3ff' }}>
          Back to missions
        </Link>
      </p>
      {entries.length === 0 ? (
        <p style={{ color: '#9aa0aa' }}>No inbox entries yet.</p>
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
              <th style={th}>Entry</th>
              <th style={th}>Mission</th>
              <th style={th}>Status</th>
              <th style={th}>Summary</th>
              <th style={th}>Updated</th>
              <th style={th}>Action</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.entry_id} style={{ borderBottom: '1px solid #1a1c22' }}>
                <td style={td}>
                  <code>{entry.entry_id}</code>
                </td>
                <td style={td}>
                  <code>{entry.mission_id ?? '—'}</code>
                </td>
                <td style={td}>{statusBadge(entry.status)}</td>
                <td style={td}>
                  <div>{entry.title}</div>
                  <div style={{ color: '#9aa0aa', marginTop: '4px' }}>{entry.summary || '—'}</div>
                </td>
                <td style={td}>
                  <code style={{ color: '#9aa0aa' }}>{entry.updated_at}</code>
                </td>
                <td style={td}>
                  <form action="/api/inbox" method="post">
                    <input type="hidden" name="entry_id" value={entry.entry_id} />
                    <input type="hidden" name="status" value="accepted" />
                    <button type="submit" style={buttonStyle}>
                      Accept
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const th: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid #2a2c33',
  fontWeight: 600,
};
const td: React.CSSProperties = { padding: '8px 12px', verticalAlign: 'top' };
const buttonStyle: React.CSSProperties = {
  border: '1px solid #2a2c33',
  background: '#0f1115',
  color: '#e4e6eb',
  padding: '6px 10px',
  borderRadius: '6px',
  cursor: 'pointer',
};

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    unread: '#8ec3ff',
    read: '#9be3a8',
    accepted: '#ffd57e',
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
