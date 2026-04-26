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

  it('maps project tracks and gate readiness through the typed wrapper', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      accessRole: 'readonly',
      projectTracks: [{ track_id: 'TRK-1', project_id: 'PRJ-1', name: 'Release 1' }],
      gateReadiness: [{
        track_id: 'TRK-1',
        ready_gate_count: 1,
        total_gate_count: 4,
        current_gate_id: 'requirements_review',
        next_required_artifacts: [{ artifact_id: 'requirements-definition', template_ref: 'knowledge/public/templates/blueprints/requirements-traceability-matrix.md' }],
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    const client = createControlPlaneClient('chronos', { baseUrl: 'http://127.0.0.1:3000' });
    const tracks = await client.listProjectTracks();
    expect(tracks[0]?.track_id).toBe('TRK-1');
    expect(tracks[0]?.gate_readiness?.current_gate_id).toBe('requirements_review');
    expect(tracks[0]?.gate_readiness?.next_required_artifacts?.[0]?.artifact_id).toBe('requirements-definition');
  });

  it('filters invalid next actions from chronos overview responses', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      accessRole: 'readonly',
      nextActions: [
        {
          action_id: 'act-1',
          next_action_type: 'approve',
          reason: 'Approval is pending',
          risk: 'medium',
          suggested_surface_action: 'approvals',
          approval_required: false,
        },
        {
          action_id: 'act-2',
          next_action_type: 'unknown-action',
          reason: 'Invalid contract',
          risk: 'low',
          suggested_surface_action: 'approvals',
          approval_required: false,
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    const client = createControlPlaneClient('chronos', { baseUrl: 'http://127.0.0.1:3000' });
    const overview = await client.getChronosOverview();
    expect(overview.nextActions).toHaveLength(1);
    expect(overview.nextActions?.[0]?.action_id).toBe('act-1');
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

  it('treats next not-found pages as stale surface mismatches', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      '<!DOCTYPE html><html><head><title>404: This page could not be found.</title></head><body>This page could not be found.</body></html>',
      { status: 404, headers: { 'content-type': 'text/html' } },
    )) as typeof fetch;

    await expect(requestControlPlaneJson('chronos', '/api/knowledge-ref?path=test'))
      .rejects
      .toMatchObject<Partial<ControlPlaneClientError>>({
        name: 'ControlPlaneClientError',
        suggestedCommand: 'pnpm surfaces:reconcile',
      });
  });
});
