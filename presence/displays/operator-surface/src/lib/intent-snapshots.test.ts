import { describe, expect, it, vi } from 'vitest';

const files: Record<string, string> = {
  '/repo/active/missions/public/MSN-PUBLIC/mission-state.json': JSON.stringify({
    mission_id: 'MSN-PUBLIC',
    tier: 'public',
    status: 'active',
    execution_mode: 'local',
    priority: 1,
    assigned_persona: 'operator',
    confidence_score: 1,
    git: { branch: 'main', start_commit: 'a', latest_commit: 'b', checkpoints: [] },
    history: [],
  }),
  '/repo/active/missions/public/MSN-PUBLIC/evidence/intent-snapshots.jsonl': JSON.stringify({
    snapshot_id: 'public-1',
    mission_id: 'MSN-PUBLIC',
    stage: 'intake',
    kind: 'origin',
    created_at: '2026-08-30T00:00:00Z',
    source: 'user_prompt',
    intent: { goal: 'public goal' },
  }),
  '/repo/active/missions/confidential/tenant-a/MSN-A/mission-state.json': JSON.stringify({
    mission_id: 'MSN-A',
    tenant_slug: 'tenant-a',
    tier: 'confidential',
    status: 'active',
    execution_mode: 'local',
    priority: 1,
    assigned_persona: 'operator',
    confidence_score: 1,
    git: { branch: 'main', start_commit: 'a', latest_commit: 'b', checkpoints: [] },
    history: [],
  }),
  '/repo/active/missions/confidential/tenant-a/MSN-A/evidence/intent-snapshots.jsonl': [
    JSON.stringify({
      snapshot_id: 'a-1',
      mission_id: 'MSN-A',
      stage: 'intake',
      kind: 'origin',
      created_at: '2026-08-30T00:00:00Z',
      source: 'user_prompt',
      intent: { goal: 'initial goal' },
    }),
    JSON.stringify({
      snapshot_id: 'a-2',
      mission_id: 'MSN-A',
      stage: 'planning',
      kind: 'current',
      created_at: '2026-08-30T01:00:00Z',
      source: 'worker_transition',
      intent: { goal: 'updated goal', constraints: ['approval'] },
    }),
  ].join('\n'),
  '/repo/active/missions/confidential/tenant-a/MSN-A/evidence/intent-deltas.jsonl': JSON.stringify({
    delta_id: 'delta-1',
    mission_id: 'MSN-A',
    from_snapshot: 'a-1',
    to_snapshot: 'a-2',
    drift_score: 0.4,
    drift_verdict: 'significant',
    changes: { goal_changed: true, goal_similarity: 0.2 },
  }),
};

vi.mock('@agent/core/path-resolver', () => ({
  pathResolver: { rootResolve: (value: string) => `/repo/${value}` },
}));
vi.mock('@agent/core/foundation', () => ({
  clamp: (value: number, min: number, max: number) => Math.min(max, Math.max(min, value)),
  isRecord: (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value),
  loadJson: <T>(value: string) => JSON.parse(files[value]) as T,
  readJsonLines: <T>(value: string) =>
    String(files[value] ?? '')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T),
}));
vi.mock('@agent/core/mission-state', () => ({
  loadStateAtPath: <T>(value: string) => {
    const raw = files[value];
    return raw ? (JSON.parse(raw) as T) : null;
  },
}));
vi.mock('@agent/core/secure-io', () => ({
  assertSafeRepositoryPath: (value: string) => value,
  safeExistsSync: (value: string) =>
    value in files ||
    [
      '/repo/active/missions/public',
      '/repo/active/missions/confidential',
      '/repo/active/missions/confidential/tenant-a',
    ].includes(value),
  safeLstat: (value: string) => ({
    isDirectory: () => !value.endsWith('.json') && !value.endsWith('.jsonl'),
    isFile: () => value.endsWith('.json') || value.endsWith('.jsonl'),
  }),
  safeReaddir: (value: string) => {
    if (value === '/repo/active/missions/public') return ['MSN-PUBLIC'];
    if (value === '/repo/active/missions/confidential') return ['tenant-a'];
    if (value === '/repo/active/missions/confidential/tenant-a') return ['MSN-A'];
    return [];
  },
  safeReadFile: (value: string) => files[value],
}));

import { listIntentSnapshotRows } from './intent-snapshots';

describe('listIntentSnapshotRows', () => {
  it('filters confidential snapshots by tenant while retaining public snapshots', () => {
    const rows = listIntentSnapshotRows({ tenantScope: 'tenant-a' });
    expect(rows.map((row) => row.mission_id)).toEqual(['MSN-A', 'MSN-A', 'MSN-PUBLIC']);
  });

  it('joins consecutive snapshots to their persisted delta', () => {
    const rows = listIntentSnapshotRows({ tenantScope: 'tenant-a' });
    const current = rows.find((row) => row.snapshot.snapshot_id === 'a-2');
    expect(current?.previous_snapshot_id).toBe('a-1');
    expect(current?.delta).toMatchObject({
      from_snapshot: 'a-1',
      drift_verdict: 'significant',
    });
  });
});
