import { describe, expect, it } from 'vitest';
import { parseCloudflareOsResponse } from './cloudflare-os-response';

describe('Cloudflare OS response parser', () => {
  it('accepts a valid snapshot and preserves display fields', () => {
    expect(
      parseCloudflareOsResponse({
        ok: true,
        heldActions: [
          {
            id: 'held-1',
            op: 'resource.introduce',
            missionId: 'mission-1',
            status: 'pending',
            submittedAt: '2026-09-01T00:00:00Z',
            submittedBy: 'human:operator',
          },
        ],
        observations: [
          {
            id: 'obs-1',
            service: 'comfyui',
            resourceRef: 'runtime/comfyui',
            tier: 'public',
            purpose: 'health',
            summary: 'ready',
            observedAt: '2026-09-01T00:00:00Z',
          },
        ],
      })
    ).toMatchObject({ ok: true });
  });

  it('rejects malformed roots and snapshot items', () => {
    expect(parseCloudflareOsResponse([])).toEqual({
      ok: false,
      error: 'Invalid OS control-plane response',
    });
    expect(parseCloudflareOsResponse({ ok: true, heldActions: [], observations: [{}] })).toEqual({
      ok: false,
      error: 'Invalid OS control-plane snapshot item',
    });
    expect(parseCloudflareOsResponse({ ok: false, error: 42 })).toEqual({
      ok: false,
      error: 'OS control-plane request failed',
    });
  });
});
