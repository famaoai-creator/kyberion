import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recordInteraction: vi.fn(),
  secureFetch: vi.fn(),
}));

vi.mock('@agent/core/relationship-graph-store', () => ({
  recordInteraction: mocks.recordInteraction,
}));
vi.mock('@agent/core/network', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/network')>()),
  secureFetch: mocks.secureFetch,
}));

import { actuator } from './index.js';

describe('presence-actuator ops through SDK dispatch (pipeline / ADF path)', () => {
  beforeEach(() => {
    mocks.recordInteraction.mockReset();
    mocks.secureFetch.mockReset();
  });

  it('record_interaction appends to the relationship graph', async () => {
    mocks.recordInteraction.mockReturnValue({ history: [{}, {}] });

    const result = await actuator.dispatch('record_interaction', {
      channel: 'operator',
      payload: { person_slug: 'aki', org: 'acme', summary: 'Agreed on the pilot scope.' },
    });

    expect(result).toMatchObject({
      ok: true,
      output: {
        status: 'interaction_recorded',
        person_slug: 'aki',
        org: 'acme',
        history_length: 2,
      },
    });
    expect(mocks.recordInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        personSlug: 'aki',
        org: 'acme',
        source: 'presence-actuator',
        interaction: expect.objectContaining({
          summary: 'Agreed on the pilot scope.',
          channel: 'operator',
        }),
      })
    );

    const missing = await actuator.dispatch('record_interaction', {
      channel: 'operator',
      payload: { person_slug: 'aki' },
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('record_interaction requires person_slug, org, and summary');
  });

  it('dispatch_timeline validates the timeline and posts it to the A2UI bridge', async () => {
    mocks.secureFetch.mockResolvedValue({ accepted: true, timeline_id: 'tl-1' });

    const result = await actuator.dispatch('dispatch_timeline', {
      channel: 'presence-studio',
      payload: {
        timeline: {
          action: 'presence_timeline',
          events: [{ at_ms: 0, op: 'set_status', params: { value: 'speaking' } }],
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      output: { status: 'timeline_dispatched', accepted: true, timeline_id: 'tl-1' },
    });
    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: expect.stringMatching(/\/api\/timeline\/dispatch$/u),
        data: expect.objectContaining({
          action: 'presence_timeline',
          surface_id: 'presence-studio',
        }),
      })
    );

    const invalid = await actuator.dispatch('dispatch_timeline', {
      channel: 'presence-studio',
      payload: { timeline: { action: 'presence_timeline', events: [] } },
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain('requires at least one event');
  });
});
