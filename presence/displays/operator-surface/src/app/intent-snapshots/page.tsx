import { emitMosRead } from '@/lib/audit-mos';

export const dynamic = 'force-dynamic';

export default function IntentSnapshotsPage() {
  emitMosRead({ page: '/intent-snapshots', resource_kind: 'intent_snapshots' });
  return (
    <section>
      <h1 style={{ marginBottom: 4 }}>Intent Snapshots</h1>
      <p style={{ color: '#9aa0aa', marginTop: 0, fontSize: 13 }}>
        Renders the temporal record of intent decisions per mission.
        <br />
        <em>
          Placeholder — full diff view between consecutive snapshots is
          tracked as a future MOS milestone.
        </em>
      </p>
      <p style={{ color: '#9aa0aa', fontSize: 13 }}>
        Until then, inspect snapshots directly in:{' '}
        <code>active/missions/&lt;tier&gt;/&lt;MSN-...&gt;/evidence/intent-snapshots.jsonl</code>
      </p>
    </section>
  );
}
