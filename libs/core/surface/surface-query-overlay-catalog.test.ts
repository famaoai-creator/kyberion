import { describe, expect, it } from 'vitest';
import {
  getSurfaceQueryOverlayCatalogEntry,
  listSurfaceQueryOverlayCatalogEntries,
} from './surface-query-overlay-catalog.js';

describe('surface-query-overlay-catalog', () => {
  it('lists shipped overlay entries', () => {
    const ids = listSurfaceQueryOverlayCatalogEntries().map((entry) => entry.id);

    expect(ids).toContain('presence_surface_agent');
    expect(ids).toContain('slack_surface_agent');
    expect(ids).toContain('chronos_surface_agent');
    expect(ids).toContain('alignment');
  });

  it('returns catalog details for a role overlay', () => {
    const entry = getSurfaceQueryOverlayCatalogEntry('slack_surface_agent');

    expect(entry?.kind).toBe('role');
    expect(entry?.path).toContain('surface-query-providers.slack_surface_agent.json');
    expect(entry?.summary).toContain('Slack-facing');
  });
});
