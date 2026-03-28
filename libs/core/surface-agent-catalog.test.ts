import { describe, expect, it } from 'vitest';
import { getSurfaceAgentCatalogEntry, listSurfaceAgentCatalog } from './surface-agent-catalog.js';

describe('surface-agent-catalog', () => {
  it('lists governed surface agents', () => {
    const entries = listSurfaceAgentCatalog();
    const ids = entries.map((entry) => entry.agentId);

    expect(ids).toContain('presence-surface-agent');
    expect(ids).toContain('slack-surface-agent');
    expect(ids).toContain('chronos-mirror');
  });

  it('extracts a useful capability view for slack surface', () => {
    const slack = getSurfaceAgentCatalogEntry('slack-surface-agent');

    expect(slack?.capabilities).toContain('delegation');
    expect(slack?.delegationTargets).toContain('nerve-agent');
    expect(slack?.deniedActuators).toContain('system-actuator');
  });
});
