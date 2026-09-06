import { describe, expect, it } from 'vitest';
import { parseMissionIntelligenceResponse } from './mission-intelligence-response';

const collectionKeys = [
  'activeMissions',
  'projects',
  'projectTracks',
  'missionSeeds',
  'distillCandidates',
  'serviceBindings',
  'recentArtifacts',
  'pendingApprovals',
  'surfaces',
  'recentEvents',
  'agentMessages',
  'a2aHandoffs',
  'controlActions',
  'ownerSummaries',
  'missionProgress',
  'browserSessions',
  'browserConversationSessions',
  'recentSurfaceOutbox',
  'runtimeLeases',
  'runtimeDoctor',
] as const;

const valid = {
  revision: 1,
  accessRole: 'readonly',
  controlActionCatalog: { mission: [], surface: [], globalSurface: [] },
  controlActionAvailability: { mission: {}, surface: {}, globalSurface: [] },
  controlActionDetails: {},
  surfaceOutbox: { slack: 0, chronos: 0 },
  runtime: { total: 0, ready: 0, busy: 0, error: 0 },
  runtimeTopology: { surfaces: [], owners: [], runtimes: [], flows: [] },
  ...Object.fromEntries(collectionKeys.map((key) => [key, []])),
};

describe('mission intelligence response boundary', () => {
  it('accepts the root fields consumed by MissionIntelligence', () => {
    expect(parseMissionIntelligenceResponse(valid)).toEqual(valid);
  });

  it('accepts optional collection sections when they are record arrays', () => {
    expect(
      parseMissionIntelligenceResponse({
        ...valid,
        projectManagement: [
          {
            project: { project_id: 'project-1', name: 'Project' },
            lineage: {
              tracks: [],
              tasks: [],
              missions: [],
              task_sessions: [],
              pipelines: [],
              role_explanations: {
                project: 'Project role',
                track: 'Track role',
                mission: 'Mission role',
                task: 'Task role',
                task_session: 'Task session role',
                pipeline: 'Pipeline role',
              },
            },
          },
        ],
        gateReadiness: [
          {
            track_id: 'track-1',
            ready_gate_count: 0,
            total_gate_count: 0,
            ready: true,
          },
        ],
        memoryCandidates: [
          {
            candidate_id: 'candidate-1',
            status: 'queued',
            proposed_memory_kind: 'pattern',
            sensitivity_tier: 'public',
            source_ref: 'mission:mission-1',
            evidence_refs: [],
          },
        ],
        nextActions: [
          {
            action_id: 'action-1',
            next_action_type: 'inspect_evidence',
            reason: 'Inspect evidence',
            risk: 'low',
            approval_required: false,
          },
        ],
        company: { tenantSlug: 'tenant-a' },
      })
    ).toBeDefined();
  });

  it('rejects missing collections, invalid revision, and primitive entries', () => {
    const missing = { ...valid };
    delete (missing as Record<string, unknown>).runtimeDoctor;
    expect(parseMissionIntelligenceResponse(missing)).toBeUndefined();
    expect(parseMissionIntelligenceResponse({ ...valid, revision: -1 })).toBeUndefined();
    expect(parseMissionIntelligenceResponse({ ...valid, activeMissions: ['bad'] })).toBeUndefined();
  });

  it('rejects invalid access roles and unsafe nested keys', () => {
    expect(parseMissionIntelligenceResponse({ ...valid, accessRole: 'admin' })).toBeUndefined();
    const unsafe = JSON.parse(
      '{"revision":1,"accessRole":"readonly","controlActionCatalog":{"mission":[],"surface":[],"globalSurface":[]},"controlActionAvailability":{"mission":{},"surface":{},"globalSurface":[]},"controlActionDetails":{},"surfaceOutbox":{"slack":0,"chronos":0},"runtime":{"total":0,"ready":0,"busy":0,"error":0},"runtimeTopology":{"surfaces":[],"owners":[],"runtimes":[],"flows":[]},"activeMissions":[],"projects":[],"projectTracks":[],"missionSeeds":[],"distillCandidates":[],"serviceBindings":[],"recentArtifacts":[],"pendingApprovals":[],"surfaces":[],"recentEvents":[],"agentMessages":[],"a2aHandoffs":[],"controlActions":[],"ownerSummaries":[],"missionProgress":[],"browserSessions":[],"browserConversationSessions":[],"recentSurfaceOutbox":[],"runtimeLeases":[],"runtimeDoctor":[{"__proto__":"bad"}]}'
    );
    expect(parseMissionIntelligenceResponse(unsafe)).toBeUndefined();
  });

  it('rejects malformed nested records instead of exposing them to the view', () => {
    expect(
      parseMissionIntelligenceResponse({
        ...valid,
        activeMissions: [
          {
            missionId: 'mission-1',
            status: 'active',
            tier: 'public',
            planReady: true,
            nextTaskCount: 0,
            controlSummary: 'ready',
            controlTone: 'unknown',
          },
        ],
      })
    ).toBeUndefined();
    expect(
      parseMissionIntelligenceResponse({
        ...valid,
        projects: [
          {
            project_id: 'project-1',
            name: 'Project',
            summary: 'Summary',
            status: 'active',
            tier: 'private',
          },
        ],
      })
    ).toBeUndefined();
    expect(
      parseMissionIntelligenceResponse({
        ...valid,
        runtime: { total: 1, ready: -1, busy: 0, error: 0 },
      })
    ).toBeUndefined();
    expect(
      parseMissionIntelligenceResponse({
        ...valid,
        runtimeTopology: {
          ...valid.runtimeTopology,
          flows: [
            {
              id: 'flow-1',
              from: 'a',
              to: 'b',
              count: -1,
              latestAt: '2026-09-04T00:00:00.000Z',
              kind: 'a2a',
            },
          ],
        },
      })
    ).toBeUndefined();
  });
});
