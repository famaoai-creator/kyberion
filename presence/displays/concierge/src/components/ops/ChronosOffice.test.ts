import { describe, expect, it } from 'vitest';

import { buildMissionRows, dedupeOfficeAgents, humanizeMissionId } from './ChronosOffice';

describe('ChronosOffice helpers', () => {
  it('keeps one visible agent entry per room when work-item projections repeat it', () => {
    const agents = [
      { agent_id: 'implementation-architect', status: 'in_progress' },
      { agent_id: 'implementation-architect', status: 'in_progress' },
      { agent_id: 'sovereign-brain', status: 'ready' },
    ];

    expect(dedupeOfficeAgents(agents)).toEqual([
      { agent_id: 'implementation-architect', status: 'in_progress' },
      { agent_id: 'sovereign-brain', status: 'ready' },
    ]);
  });
});

describe('UI-07 mission rows', () => {
  it('uses human titles and sorts by attention', () => {
    const rows = buildMissionRows(
      [
        {
          room_id: 'MSN-QUIET-WORK-20260901',
          title: '',
          agents: [{ agent_id: 'x', status: 'ready' }],
        },
        {
          room_id: 'MSN-HOT-20260902A',
          title: '',
          agents: [
            { agent_id: 'y', status: 'blocked' },
            { agent_id: 'z', status: 'review' },
          ],
        },
      ],
      { 'MSN-HOT-20260902A': 'Ship the proposal deck' }
    );
    expect(rows.map((row) => [row.title, row.status, row.attention])).toEqual([
      ['Ship the proposal deck', 'blocked', 2],
      ['Quiet work', 'ready', 0],
    ]);
    expect(humanizeMissionId('MSN-BACKEND-CAPABILITY-CONSOLIDATION-20260822A')).toBe(
      'Backend capability consolidation'
    );
  });
});
