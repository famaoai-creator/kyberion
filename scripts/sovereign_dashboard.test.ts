import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  pathResolver,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '@agent/core';
import {
  listJsonFiles,
  readMissionDashboardState,
  readDashboardOperatorIdentity,
  readDashboardJsonValueIfExists,
  readDashboardTextFile,
  readProviderCapabilitySnapshot,
  readSurfaceDashboardState,
  safeListDir,
} from './sovereign_dashboard.js';

const resourceBoundaryRoot = pathResolver.sharedTmp(`sovereign-dashboard-boundary-${process.pid}`);

afterEach(() => {
  safeRmSync(resourceBoundaryRoot, { recursive: true, force: true });
  safeRmSync(`${resourceBoundaryRoot}-outside`, { recursive: true, force: true });
});

describe('sovereign dashboard governance loaders', () => {
  it('rejects a directory replacement before dashboard log parsing', () => {
    expect(() => readDashboardTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

  it('reuses governed readiness and trust loaders', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/sovereign_dashboard.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadServiceConnectionReadinessConfig()');
    expect(source).toContain('loadPersistedTrustLedger()');
    expect(source).toContain('loadSkillIndex()');
    expect(source).toContain('loadSurfaceState(');
    expect(source).toContain('loadPersonalIdentityAtPath(');
    expect(source).toContain('loadServiceConnectionAtPath(');
    expect(source).not.toContain('product/governance/service-connection-readiness.json');
    expect(source).not.toContain('personal/governance/agent-trust-scores.json');
    expect(source).not.toContain(
      "}>(pathResolver.knowledge('product/orchestration/global_skill_index.json'))"
    );
    expect(source).toContain('readSafeJsonValueFile');
    expect(source).not.toContain('readJsonIfExists<T>');
    expect(source).toContain('renderDashboardSnapshot');
    expect(source).toContain('print(snapshot)');
    expect(source).not.toContain("name: 'dashboard', flags: []");
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('process.stdout.write');
    expect(source).toContain('clearOutput: print');
    expect(source).toContain('main(argv, print)');
  });

  it('does not enumerate symlinked mission or connection resources', () => {
    const outside = `${resourceBoundaryRoot}-outside`;
    const missionLink = path.join(resourceBoundaryRoot, 'mission-link');
    const connectionLink = path.join(resourceBoundaryRoot, 'connection-link.json');
    safeMkdir(outside, { recursive: true });
    safeWriteFile(path.join(outside, 'mission-state.json'), '{}');
    safeWriteFile(path.join(outside, 'connection.json'), '{}');
    safeMkdir(resourceBoundaryRoot, { recursive: true });
    safeSymlinkSync(outside, missionLink);
    safeSymlinkSync(path.join(outside, 'connection.json'), connectionLink);

    expect(safeListDir(resourceBoundaryRoot)).toEqual([]);
    expect(listJsonFiles(resourceBoundaryRoot)).toEqual([]);
  });

  it('projects only active mission state with a valid mission id', () => {
    const statePath = path.join(resourceBoundaryRoot, 'mission-state.json');
    safeMkdir(resourceBoundaryRoot, { recursive: true });

    safeWriteFile(
      statePath,
      JSON.stringify({
        mission_id: 'MSN-DASHBOARD',
        tier: 'confidential',
        status: 'active',
        execution_mode: 'local',
        priority: 1,
        assigned_persona: 'operator',
        confidence_score: 1,
        git: {
          branch: 'main',
          start_commit: 'abc1234',
          latest_commit: 'abc1234',
          checkpoints: [],
        },
        history: [],
      })
    );
    expect(readMissionDashboardState(statePath)).toEqual({
      status: 'active',
      mission_id: 'MSN-DASHBOARD',
      tier: 'confidential',
    });

    safeWriteFile(
      statePath,
      JSON.stringify({
        mission_id: ['not-a-id'],
        tier: 'confidential',
        status: 'active',
        execution_mode: 'local',
        priority: 1,
        assigned_persona: 'operator',
        confidence_score: 1,
        git: {
          branch: 'main',
          start_commit: 'abc1234',
          latest_commit: 'abc1234',
          checkpoints: [],
        },
        history: [],
      })
    );
    expect(readMissionDashboardState(statePath)).toBeNull();

    safeWriteFile(statePath, JSON.stringify(['not-a-state']));
    expect(readMissionDashboardState(statePath)).toBeNull();
  });

  it('fails closed when the persisted surface state is malformed', () => {
    const statePath = pathResolver.sharedTmp(
      `sovereign-dashboard-surface-state-${process.pid}.json`
    );
    safeWriteFile(statePath, JSON.stringify({ version: 1, surfaces: { chronos: { pid: 123 } } }));

    expect(readSurfaceDashboardState(statePath)).toEqual({ version: 1, surfaces: {} });
  });

  it('fails closed when the provider capability snapshot is malformed', () => {
    const snapshotPath = pathResolver.sharedTmp(
      `sovereign-dashboard-provider-capabilities-${process.pid}.json`
    );
    safeWriteFile(
      snapshotPath,
      JSON.stringify({
        generated_at: '2026-09-03T00:00:00.000Z',
        registered_capabilities: 1,
        available_capabilities: 1,
        available_providers: ['alpha'],
        missing_providers: [],
        providers: [],
        capabilities: [],
        unexpected: true,
      })
    );

    expect(readProviderCapabilitySnapshot(snapshotPath)).toBeNull();
  });

  it('uses the canonical safe operator identity projection', () => {
    const identityPath = path.join(resourceBoundaryRoot, 'my-identity.json');
    safeMkdir(resourceBoundaryRoot, { recursive: true });
    safeWriteFile(identityPath, JSON.stringify({ name: ' Operator ', secret: 'hidden' }));
    expect(readDashboardOperatorIdentity(identityPath)).toEqual({ name: 'Operator' });

    safeWriteFile(identityPath, JSON.stringify({ name: 42 }));
    expect(readDashboardOperatorIdentity(identityPath)).toBeNull();
  });

  it('fails closed for dangerous dashboard JSON values', () => {
    const jsonPath = path.join(resourceBoundaryRoot, 'dashboard.json');
    safeMkdir(resourceBoundaryRoot, { recursive: true });
    safeWriteFile(jsonPath, '{"__proto__":{"polluted":true},"version":"1.0.0"}');

    expect(readDashboardJsonValueIfExists<{ version?: string }>(jsonPath)).toBeNull();
  });
});
