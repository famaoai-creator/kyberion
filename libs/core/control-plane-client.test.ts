import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ControlPlaneClientError,
  createControlPlaneClient,
  requestControlPlaneJson,
} from './control-plane-client.js';

const originalFetch = globalThis.fetch;

describe('control-plane-client', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('lists presence projects through the typed client wrapper', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      items: [{ project_id: 'PRJ-123', name: 'Demo', status: 'active' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    const client = createControlPlaneClient('presence', { baseUrl: 'http://127.0.0.1:3031' });
    const projects = await client.listProjects();
    expect(projects[0]?.project_id).toBe('PRJ-123');
    expect(projects[0]?.name).toBe('Demo');
  });

  it('maps chronos overview into typed approval and mission seed wrappers', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      accessRole: 'readonly',
      pendingApprovals: [{ id: 'APR-1', title: 'Approve deploy' }],
      missionSeeds: [{ seed_id: 'MSD-1', title: 'Architecture seed' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    const client = createControlPlaneClient('chronos', { baseUrl: 'http://127.0.0.1:3000' });
    const approvals = await client.listApprovals();
    const seeds = await client.listMissionSeeds();
    expect(approvals[0]?.id).toBe('APR-1');
    expect(seeds[0]?.seed_id).toBe('MSD-1');
  });

  it('raises a stale surface error with a suggested command', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      '<html><body><pre>Cannot GET /api/projects</pre></body></html>',
      { status: 404, headers: { 'content-type': 'text/html' } },
    )) as typeof fetch;

    await expect(requestControlPlaneJson('presence', '/api/projects'))
      .rejects
      .toMatchObject<Partial<ControlPlaneClientError>>({
        name: 'ControlPlaneClientError',
        suggestedCommand: 'pnpm surfaces:reconcile',
      });
  });
});
