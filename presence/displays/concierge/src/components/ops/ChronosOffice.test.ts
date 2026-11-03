import { describe, expect, it } from 'vitest';

import { dedupeOfficeAgents } from './ChronosOffice';

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
