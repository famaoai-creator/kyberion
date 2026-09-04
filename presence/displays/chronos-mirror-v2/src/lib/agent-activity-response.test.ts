import { describe, expect, it } from 'vitest';
import { parseAgentActivityResponse } from './agent-activity-response';

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
