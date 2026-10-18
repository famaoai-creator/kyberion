import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MissionState } from '@agent/core/mission/mission-types';
import { buildMissionHistoryItems } from './su-surface-data';

// Exercise the production directory walk with in-memory boundary adapters only.
// No mission state, configuration, artifact store, or provider is read from disk.
const mocks = vi.hoisted(() => ({
  directories: new Map<string, string[]>(),
  states: new Map<string, MissionState>(),
  deniedRoots: new Set<string>(),
  rootResolve: vi.fn<(value: string) => string>(),
  assertSafeRepositoryPath: vi.fn<(value: string) => string>(),
  loadStateAtPath: vi.fn<(value: string) => MissionState | undefined>(),
}));

vi.mock('@agent/core/metrics', () => ({
  MetricsCollector: vi.fn(),
  metricsWithheldNotice: vi.fn(),
}));
vi.mock('@agent/core/cost-report', () => ({ executionMetricsReadFor: vi.fn() }));
vi.mock('@agent/core/event-scope', () => ({ eventScopeMatches: vi.fn() }));
vi.mock('@agent/core/generation-cost-settlement', () => ({
  listGenerationCostSettlements: vi.fn(),
}));
vi.mock('@agent/core/scope-migration', () => ({ resolveScopeForRecord: vi.fn() }));
vi.mock('@agent/core/governance/approval-store', () => ({
  computeApprovalPresentedDigest: vi.fn(),
  listApprovalRequests: vi.fn(),
}));
vi.mock('@agent/core/workforce/artifact-record', () => ({ listArtifactRecords: () => [] }));
vi.mock('@agent/core/mission/mission-management-config', () => ({
  loadMissionManagementConfig: () => ({
    version: '1',
    directories: {
      personal: 'missions/personal',
      confidential: 'missions/confidential',
      public: 'missions/public',
    },
  }),
}));
vi.mock('@agent/core/mission/mission-state', () => ({
  loadState: vi.fn(),
  loadStateAtPath: mocks.loadStateAtPath,
}));
vi.mock('@agent/core/path-resolver', () => ({
  rootResolve: mocks.rootResolve,
  findMissionPath: vi.fn(),
}));
vi.mock('@agent/core/secure-io', () => ({
  assertSafeRepositoryPath: mocks.assertSafeRepositoryPath,
  safeExistsSync: (value: string) => mocks.directories.has(value) || mocks.states.has(value),
  safeLstat: (value: string) => ({
    isDirectory: () => mocks.directories.has(value),
    isFile: () => mocks.states.has(value),
  }),
  safeReaddir: (value: string) => mocks.directories.get(value) || [],
}));

const fixtureRoot = path.resolve('virtual-mission-discovery');

function addMission(tier: MissionState['tier'], tenant: string, missionId: string): string {
  const root = path.join(fixtureRoot, 'missions', tier);
  const tenantDir = path.join(root, tenant);
  const missionDir = path.join(tenantDir, missionId);
  const statePath = path.join(missionDir, 'mission-state.json');
  mocks.directories.set(root, [...(mocks.directories.get(root) || []), tenant]);
  mocks.directories.set(tenantDir, [missionId]);
  mocks.directories.set(missionDir, []);
  mocks.states.set(statePath, {
    mission_id: missionId,
    tier,
    tenant_slug: tenant,
    status: 'active',
    execution_mode: 'local',
    priority: 1,
    assigned_persona: 'operator',
    confidence_score: 1,
    git: { branch: 'main', start_commit: 'a', latest_commit: 'a', checkpoints: [] },
    history: [{ ts: '2026-10-18T00:00:00.000Z', event: 'started', note: 'fixture' }],
    intent: { goal_summary: 'Discover the configured mission' },
  });
  return statePath;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.directories.clear();
  mocks.states.clear();
  mocks.deniedRoots.clear();
  mocks.rootResolve.mockImplementation((value) => path.join(fixtureRoot, value));
  mocks.assertSafeRepositoryPath.mockImplementation((value) => {
    if (mocks.deniedRoots.has(value)) throw new Error('Unauthorized mission root');
    return value;
  });
  mocks.loadStateAtPath.mockImplementation((value) => mocks.states.get(value));
});

describe('mission history production discovery', () => {
  it('loads a configured authorized mission through the nested directory walk', () => {
    const statePath = addMission('confidential', 'tenant-a', 'MSN-DISCOVERY');

    expect(buildMissionHistoryItems()).toEqual([
      expect.objectContaining({
        missionId: 'MSN-DISCOVERY',
        tier: 'confidential',
        tenantSlug: 'tenant-a',
        status: 'active',
        goalSummary: 'Discover the configured mission',
      }),
    ]);
    expect(mocks.rootResolve).toHaveBeenCalledWith('missions/confidential');
    expect(mocks.assertSafeRepositoryPath).toHaveBeenCalledWith(statePath, {
      allowMissingLeaf: true,
    });
    expect(mocks.loadStateAtPath).toHaveBeenCalledExactlyOnceWith(statePath);
  });

  it('retains tier and tenant narrowing while skipping unauthorized roots', () => {
    addMission('confidential', 'tenant-a', 'MSN-ALLOWED');
    addMission('confidential', 'tenant-b', 'MSN-OTHER-TENANT');
    addMission('public', 'tenant-a', 'MSN-OTHER-TIER');
    const deniedStatePath = addMission('personal', 'tenant-a', 'MSN-DENIED');
    mocks.deniedRoots.add(path.join(fixtureRoot, 'missions/personal'));

    const items = buildMissionHistoryItems({ tier: 'confidential', tenantSlugs: ['tenant-a'] });

    expect(items.map((item) => item.missionId)).toEqual(['MSN-ALLOWED']);
    expect(mocks.loadStateAtPath).toHaveBeenCalledTimes(3);
    expect(mocks.loadStateAtPath).not.toHaveBeenCalledWith(deniedStatePath);
  });
});
