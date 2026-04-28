import { notFound } from 'next/navigation';
import { getMissionDetail, suggestedCommand } from '@/lib/data';
import { emitMosRead } from '@/lib/audit-mos';

export const dynamic = 'force-dynamic';

export default async function MissionDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const detail = getMissionDetail(params.id);
  if (!detail) notFound();
  emitMosRead({
    page: `/missions/${params.id}`,
    resource_kind: 'mission_detail',
    resource_id: detail.mission_id,
  });

  return (
    <section>
      <h1 style={{ marginBottom: 0 }}>{detail.mission_id}</h1>
      <p style={{ color: '#9aa0aa', marginTop: 4, fontSize: 13 }}>
        <code>tier={detail.tier}</code>
        {detail.tenant_slug ? <> · <code>tenant={detail.tenant_slug}</code></> : null}
        {' · '}
        <code>status={detail.status}</code>
        {' · '}
        <code>persona={detail.assigned_persona ?? '—'}</code>
      </p>

      <h2 style={{ marginTop: 28 }}>Suggested next actions</h2>
      <p style={{ color: '#9aa0aa', fontSize: 13, marginTop: 4 }}>
        These are <em>copy-and-run</em> commands. The MOS never executes them
        for you — that boundary is intentional and audit-load-bearing.
      </p>
      <ul style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>
        {(['verify', 'distill', 'finish', 'export-bundle', 'view-evidence'] as const).map(
          (intent) => (
            <li key={intent} style={{ marginBottom: 6 }}>
              <span style={{ color: '#9aa0aa' }}>{intent}: </span>
              <code style={codeBg}>
                {suggestedCommand({ intent, missionId: detail.mission_id })}
              </code>
            </li>
          ),
        )}
      </ul>

      <h2 style={{ marginTop: 28 }}>History ({detail.history_count})</h2>
      {detail.history && detail.history.length > 0 ? (
        <ul style={{ fontSize: 13 }}>
          {detail.history.map((h, i) => (
            <li key={i} style={{ marginBottom: 4 }}>
              <code style={{ color: '#9aa0aa' }}>{h.ts}</code>{' '}
              <strong>{h.event}</strong>
              {h.note ? <span style={{ color: '#9aa0aa' }}> — {h.note}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ color: '#9aa0aa' }}>(no history)</p>
      )}

      <h2 style={{ marginTop: 28 }}>Checkpoints ({detail.checkpoints_count ?? 0})</h2>
      {detail.checkpoints && detail.checkpoints.length > 0 ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#15171c', textAlign: 'left' }}>
              <th style={th}>Task</th>
              <th style={th}>Commit</th>
              <th style={th}>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {detail.checkpoints.map((c) => (
              <tr key={c.commit_hash} style={{ borderBottom: '1px solid #1a1c22' }}>
                <td style={td}>{c.task_id}</td>
                <td style={td}>
                  <code>{c.commit_hash.slice(0, 8)}</code>
                </td>
                <td style={td}>{c.ts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p style={{ color: '#9aa0aa' }}>(no checkpoints)</p>
      )}

      <h2 style={{ marginTop: 28 }}>Evidence files ({detail.evidence_files?.length ?? 0})</h2>
      {detail.evidence_files && detail.evidence_files.length > 0 ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#15171c', textAlign: 'left' }}>
              <th style={th}>Name</th>
              <th style={th}>Bytes</th>
              <th style={th}>Modified</th>
            </tr>
          </thead>
          <tbody>
            {detail.evidence_files.map((f) => (
              <tr key={f.name} style={{ borderBottom: '1px solid #1a1c22' }}>
                <td style={td}>
                  <code>{f.name}</code>
                </td>
                <td style={td}>{f.bytes.toLocaleString()}</td>
                <td style={td}>{f.modified_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p style={{ color: '#9aa0aa' }}>(no evidence files)</p>
      )}
    </section>
  );
}

const th: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #2a2c33', fontWeight: 600 };
const td: React.CSSProperties = { padding: '8px 12px', verticalAlign: 'top' };
const codeBg: React.CSSProperties = {
  background: '#15171c',
  padding: '2px 6px',
  borderRadius: 3,
  fontSize: 12,
};
