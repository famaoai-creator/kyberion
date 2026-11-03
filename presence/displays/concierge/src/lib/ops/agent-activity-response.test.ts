import { describe, expect, it } from 'vitest';
import {
  parseAgentActivityBoardResponse,
  parseAgentActivityResponse,
} from './agent-activity-response';

const valid = {
  ok: true,
  office: {
    rooms: [
      {
        room_id: 'room-1',
        title: 'Delivery',
        agents: [
          {
            agent_id: 'agent-1',
            status: 'in_progress',
            pressure: { severity: 'normal', value: 0.2 },
          },
        ],
      },
    ],
    attention: [{ agent_id: 'agent-2' }],
  },
  trackRecords: [
    { agent_id: 'agent-1', completed_tasks: 3, review_pass_rate: 0.75, rank: 'steady' },
  ],
};

describe('parseAgentActivityResponse', () => {
  it('accepts the office projection', () => {
    expect(parseAgentActivityResponse(valid)).toEqual({
      rooms: valid.office.rooms,
      attention: valid.office.attention,
      trackRecords: valid.trackRecords,
    });
  });

  it.each([
    ['not ok', { ...valid, ok: false }],
    [
      'invalid agent',
      {
        ...valid,
        office: {
          ...valid.office,
          rooms: [{ ...valid.office.rooms[0], agents: [{ agent_id: 'agent-1' }] }],
        },
      },
    ],
    [
      'invalid pressure',
      {
        ...valid,
        office: {
          ...valid.office,
          rooms: [
            {
              ...valid.office.rooms[0],
              agents: [
                { ...valid.office.rooms[0].agents[0], pressure: { severity: 'normal', value: -1 } },
              ],
            },
          ],
        },
      },
    ],
    [
      'invalid review rate',
      {
        ...valid,
        trackRecords: [{ ...valid.trackRecords[0], review_pass_rate: 2 }],
      },
    ],
    ['invalid attention', { ...valid, office: { ...valid.office, attention: [{ agent_id: [] }] } }],
    ['dangerous key', { ...valid, office: { ...valid.office, ['__proto__']: { polluted: true } } }],
  ])('rejects %s', (_label, value) => {
    expect(parseAgentActivityResponse(value)).toBeUndefined();
  });
});

describe('parseAgentActivityBoardResponse', () => {
  const board = {
    generated_at: '2026-09-04T00:00:00.000Z',
    tenant: 'tenant-a',
    entries: [
      {
        agent_id: 'agent-1',
        team_role: 'reviewer',
        mission_id: 'mission-1',
        tenant_slug: 'tenant-a',
        item_id: 'work-1',
        title: 'Review work',
        status: 'blocked',
        phase: 'review',
        blockers: [{ kind: 'blocked', reason: 'Waiting for input' }],
        updated_at: '2026-09-04T00:00:00.000Z',
      },
    ],
    agents: [{ agent_id: 'agent-1', active: 0, blocked: 1, in_review: 0 }],
  };

  it('accepts the board fields consumed by AgentOpsBoards', () => {
    expect(parseAgentActivityBoardResponse({ ok: true, board })).toEqual({ board });
  });

  it('accepts an empty board', () => {
    expect(
      parseAgentActivityBoardResponse({
        ok: true,
        board: { generated_at: '2026-09-04T00:00:00.000Z', entries: [], agents: [] },
      })
    ).toMatchObject({ board: { entries: [], agents: [] } });
  });

  it('rejects invalid blocker kinds and counters', () => {
    expect(
      parseAgentActivityBoardResponse({
        ok: true,
        board: {
          ...board,
          entries: [{ ...board.entries[0], blockers: [{ kind: 'info', reason: 'bad' }] }],
        },
      })
    ).toBeUndefined();
    expect(
      parseAgentActivityBoardResponse({
        ok: true,
        board: { ...board, agents: [{ ...board.agents[0], active: -1 }] },
      })
    ).toBeUndefined();
  });

  it('rejects unsafe nested keys and non-object boards', () => {
    const unsafe = JSON.parse(
      '{"ok":true,"board":{"generated_at":"2026-09-04T00:00:00.000Z","entries":[],"agents":[{"agent_id":"agent-1","active":0,"blocked":0,"in_review":0,"__proto__":"bad"}]}}'
    );
    expect(parseAgentActivityBoardResponse(unsafe)).toBeUndefined();
    expect(parseAgentActivityBoardResponse({ ok: true, board: [] })).toBeUndefined();
  });
});
