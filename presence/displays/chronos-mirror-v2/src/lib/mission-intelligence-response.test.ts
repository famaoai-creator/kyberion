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
  controlActionCatalog: {},
  controlActionAvailability: {},
  controlActionDetails: {},
  surfaceOutbox: { slack: 0, chronos: 0 },
  runtime: { total: 0, ready: 0, busy: 0, error: 0 },
  runtimeTopology: {},
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
        projectManagement: [{ project_id: 'project-1' }],
        gateReadiness: [{ track_id: 'track-1' }],
        memoryCandidates: [{ candidate_id: 'candidate-1' }],
        nextActions: [{ action_id: 'action-1' }],
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
      '{"revision":1,"accessRole":"readonly","controlActionCatalog":{},"controlActionAvailability":{},"controlActionDetails":{},"surfaceOutbox":{},"runtime":{},"runtimeTopology":{},"activeMissions":[],"projects":[],"projectTracks":[],"missionSeeds":[],"distillCandidates":[],"serviceBindings":[],"recentArtifacts":[],"pendingApprovals":[],"surfaces":[],"recentEvents":[],"agentMessages":[],"a2aHandoffs":[],"controlActions":[],"ownerSummaries":[],"missionProgress":[],"browserSessions":[],"browserConversationSessions":[],"recentSurfaceOutbox":[],"runtimeLeases":[],"runtimeDoctor":[{"__proto__":"bad"}]}'
    );
    expect(parseMissionIntelligenceResponse(unsafe)).toBeUndefined();
  });
});
