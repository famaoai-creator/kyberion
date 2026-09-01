import { describe, expect, it, vi } from 'vitest';

const viewer = vi.hoisted(() => ({
  context: {
    role: 'localadmin' as const,
    tenantSlugs: 'all' as string[] | 'all',
    source: 'loopback' as 'loopback' | 'token',
  },
}));
const requireAccess = vi.hoisted(() => vi.fn(() => null));

vi.mock('../../../lib/api-guard', () => ({
  guardRequest: vi.fn(() => null),
  requireChronosAccess: requireAccess,
}));

vi.mock('../../../lib/viewer-context', () => ({
  resolveViewerContextForRequest: vi.fn(() => viewer),
}));

import { POST } from './route.js';
import {
  parseChronosAuditEvent,
  parseChronosMissionProposalState,
} from './chronos-persisted-parsers.js';

describe('chronos agent route', () => {
  it('accepts only shape-valid persisted mission proposals and audit events', () => {
    const routingDecision = {
      kind: 'agent-routing-decision',
      source_text: 'start a mission',
      intent_id: 'create-mission',
      mode: 'coordination',
      scope: 'stateful_flow',
      autonomy: 'medium',
      boundary_crossing: false,
      fanout: 'none',
      owner: 'chronos-mirror',
      artifact_count: 0,
      stop_condition: 'mission issued',
      rationale: 'mission request',
    };
    expect(
      parseChronosMissionProposalState({
        surface: 'chronos',
        channel: 'chronos',
        threadTs: 'proposal-1',
        proposal: { intent: 'create_mission', tier: 'public', summary: 'Start a mission' },
        routingDecision,
        createdAt: '2026-09-01T00:00:00.000Z',
      })
    ).toEqual(
      expect.objectContaining({
        threadTs: 'proposal-1',
        proposal: expect.objectContaining({ intent: 'create_mission', tier: 'public' }),
        routingDecision,
      })
    );
    expect(
      parseChronosMissionProposalState({
        surface: 'chronos',
        channel: 'chronos',
        threadTs: 'proposal-1',
        proposal: { intent: 'create_mission', tier: 'private' },
        createdAt: '2026-09-01T00:00:00.000Z',
      })
    ).toBeNull();
    expect(parseChronosAuditEvent([])).toBeNull();
    expect(parseChronosAuditEvent({ event_type: 'mission_started', mission_id: 42 })).toEqual({
      event_type: 'mission_started',
    });
  });

  it('returns a user-facing envelope when request parsing fails', async () => {
    const request = {
      headers: new Headers({
        'content-type': 'application/json',
        authorization: 'Bearer local-test-token',
        'x-forwarded-for': '127.0.0.1',
      }),
      cookies: {
        get: () => undefined,
      },
      ip: '127.0.0.1',
      json: async () => JSON.parse('{'),
    } as any;

    const previousRole = process.env.MISSION_ROLE;
    process.env.KYBERION_API_TOKEN = 'local-test-token';
    const response = await POST(request);
    delete process.env.KYBERION_API_TOKEN;

    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error: string;
    };
    expect(payload.error).toBeTruthy();
    expect(payload.error).not.toContain('Unexpected token');
    expect(process.env.MISSION_ROLE).toBe(previousRole);
  });

  it.each([
    ['null body', null],
    ['array body', []],
    ['non-string query', { query: { unexpected: true } }],
  ])('rejects %s as a client error', async (_label, body) => {
    const request = {
      headers: new Headers({ 'content-type': 'application/json' }),
      cookies: { get: () => undefined },
      ip: '127.0.0.1',
      json: async () => body,
    } as any;

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBeTruthy();
  });

  it('requires localadmin before executing a quick action', async () => {
    requireAccess.mockReturnValueOnce({ status: 403 });
    const request = {
      headers: new Headers({ 'content-type': 'application/json' }),
      cookies: { get: () => undefined },
      ip: '127.0.0.1',
      json: async () => ({ query: 'chronos://quick-action/schedule-tick' }),
    } as any;

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(requireAccess).toHaveBeenCalledWith(request, 'localadmin');
    requireAccess.mockReset().mockReturnValue(null);
  });

  it('requires localadmin before accepting a mission proposal action', async () => {
    requireAccess.mockReturnValueOnce({ status: 403 });
    const request = {
      headers: new Headers({ 'content-type': 'application/json' }),
      cookies: { get: () => undefined },
      ip: '127.0.0.1',
      json: async () => ({ action: 'approve_mission', sessionId: 'proposal-1' }),
    } as any;

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(requireAccess).toHaveBeenCalledWith(request, 'localadmin');
    requireAccess.mockReset().mockReturnValue(null);
  });

  it('rejects repository-wide quick actions for tenant-scoped viewers', async () => {
    viewer.context = { role: 'localadmin', tenantSlugs: ['tenant-a'], source: 'token' };
    const request = {
      headers: new Headers({ 'content-type': 'application/json' }),
      cookies: { get: () => undefined },
      ip: '127.0.0.1',
      json: async () => ({ query: 'chronos://quick-action/audit-log' }),
    } as any;

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain('all-tenant');
    viewer.context = { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' };
  });

  it('rejects the repository-wide pipeline shortcut for tenant-scoped viewers', async () => {
    viewer.context = { role: 'localadmin', tenantSlugs: ['tenant-a'], source: 'token' };
    const request = {
      headers: new Headers({ 'content-type': 'application/json' }),
      cookies: { get: () => undefined },
      ip: '127.0.0.1',
      json: async () => ({
        query: 'node dist/scripts/run_pipeline.js --input pipelines/baseline-check.json',
      }),
    } as any;

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain('pipeline shortcuts');
    viewer.context = { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' };
  });
});
