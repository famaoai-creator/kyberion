import { describe, expect, it } from 'vitest';
import { parseFocusedOperatorResponse } from './focused-operator-response';

const valid = {
  revision: 1,
  activeMissions: [
    {
      missionId: 'mission-1',
      tier: 'public',
      missionType: 'development',
      nextTaskCount: 1,
      controlSummary: 'ready',
      controlTone: 'ready',
    },
  ],
  missionProgress: [
    {
      missionId: 'mission-1',
      boardStatus: 'active',
      boardStepsTotal: 2,
      boardStepsDone: 1,
      boardStepsActive: 1,
      boardStepsPending: 0,
      nextTasksTotal: 1,
      nextTasksPending: 1,
      nextTasksCompleted: 0,
      dependencies: [],
      generatedAssets: [
        {
          path: 'active/missions/public/mission-1/PLAN.md',
          category: 'evidence',
          sizeBytes: 4,
          updatedAt: '2026-09-04T00:00:00.000Z',
        },
      ],
    },
  ],
  secretApprovals: [
    {
      id: 'approval-1',
      title: 'Rotate key',
      summary: 'Approval required.',
      storageChannel: 'chronos',
      requestedAt: '2026-09-04T00:00:00.000Z',
      requestedBy: 'operator',
      serviceId: 'service-1',
      secretKey: 'API_KEY',
      mutation: 'rotate',
      riskLevel: 'high',
      requiresStrongAuth: true,
      pendingRoles: ['localadmin'],
      kind: 'secret_mutation',
    },
  ],
  a2aHandoffs: [
    { ts: '2026-09-04T00:00:00.000Z', missionId: 'mission-1', sender: 'a', receiver: 'b' },
  ],
  runtimeDoctor: [
    {
      severity: 'warning',
      agentId: 'agent-1',
      ownerId: 'mission-1',
      reason: 'Review runtime.',
      recommendedAction: 'restart_runtime',
    },
  ],
  surfaces: [
    {
      id: 'chronos',
      health: 'healthy',
      controlSummary: 'stable',
      controlTone: 'stable',
      running: true,
    },
  ],
  recentSurfaceOutbox: [
    {
      message_id: 'message-1',
      surface: 'chronos',
      channel: 'chronos',
      text: 'Hello',
      created_at: '2026-09-04T00:00:00.000Z',
    },
  ],
  computerSessions: [
    {
      id: 'session-1',
      kind: 'browser',
      status: 'active',
      updatedAt: '2026-09-04T00:00:00.000Z',
      actionCount: 0,
    },
  ],
  runtimeTopology: {
    surfaces: [{ id: 'chronos', kind: 'surface', running: true }],
    owners: [{ id: 'mission-1', type: 'mission', runtimeCount: 1, runtimeIds: ['agent-1'] }],
    runtimes: [
      {
        agentId: 'agent-1',
        provider: 'stub',
        status: 'ready',
        ownerId: 'mission-1',
        ownerType: 'mission',
        recentActivityCount: 0,
      },
    ],
    flows: [
      {
        id: 'flow-1',
        from: 'a',
        to: 'b',
        count: 1,
        latestAt: '2026-09-04T00:00:00.000Z',
        kind: 'a2a',
      },
    ],
  },
  runtime: { total: 1, ready: 1, busy: 0, error: 0 },
  ownerSummaries: [
    {
      ts: '2026-09-04T00:00:00.000Z',
      mission_id: 'mission-1',
      accepted_count: 1,
      reviewed_count: 0,
      completed_count: 0,
      requested_count: 1,
    },
  ],
  recentEvents: [{ ts: '2026-09-04T00:00:00.000Z', decision: 'started', mission_id: 'mission-1' }],
};

describe('focused operator response boundary', () => {
  it('accepts the fields consumed by FocusedOperatorView', () => {
    expect(parseFocusedOperatorResponse(valid)).toMatchObject({
      revision: valid.revision,
      activeMissions: valid.activeMissions,
      missionProgress: valid.missionProgress,
      secretApprovals: valid.secretApprovals,
      runtimeTopology: valid.runtimeTopology,
    });
  });

  it('accepts empty collections and optional runtime', () => {
    const { runtime: _runtime, ...withoutRuntime } = valid;
    expect(
      parseFocusedOperatorResponse({
        ...withoutRuntime,
        activeMissions: [],
        missionProgress: [],
        secretApprovals: [],
        a2aHandoffs: [],
        runtimeDoctor: [],
        surfaces: [],
        recentSurfaceOutbox: [],
        computerSessions: [],
        runtimeTopology: { surfaces: [], owners: [], runtimes: [], flows: [] },
        ownerSummaries: [],
        recentEvents: [],
      })
    ).toBeDefined();
  });

  it('rejects invalid enum values and counters', () => {
    expect(
      parseFocusedOperatorResponse({
        ...valid,
        activeMissions: [{ ...valid.activeMissions[0], controlTone: 'unknown' }],
      })
    ).toBeUndefined();
    expect(
      parseFocusedOperatorResponse({
        ...valid,
        runtime: { total: 1, ready: -1, busy: 0, error: 0 },
      })
    ).toBeUndefined();
  });

  it('rejects unsafe nested keys and malformed topology entries', () => {
    const unsafe = JSON.parse(
      '{"revision":1,"activeMissions":[],"missionProgress":[],"secretApprovals":[],"a2aHandoffs":[],"runtimeDoctor":[],"surfaces":[],"recentSurfaceOutbox":[],"computerSessions":[],"runtimeTopology":{"surfaces":[],"owners":[],"runtimes":[],"flows":[{"id":"flow-1","from":"a","to":"b","count":1,"latestAt":"2026-09-04T00:00:00.000Z","kind":"a2a","__proto__":"bad"}]},"ownerSummaries":[],"recentEvents":[]}'
    );
    expect(parseFocusedOperatorResponse(unsafe)).toBeUndefined();
    expect(
      parseFocusedOperatorResponse({
        ...valid,
        runtimeTopology: {
          ...valid.runtimeTopology,
          flows: [{ ...valid.runtimeTopology.flows[0], count: -1 }],
        },
      })
    ).toBeUndefined();
  });
});
