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
    expect(source).not.toContain('product/governance/service-connection-readiness.json');
    expect(source).not.toContain('personal/governance/agent-trust-scores.json');
    expect(source).not.toContain(
      "}>(pathResolver.knowledge('product/orchestration/global_skill_index.json'))"
    );
    expect(source).toContain('renderDashboardSnapshot');
    expect(source).toContain('print(snapshot)');
    expect(source).not.toContain("name: 'dashboard', flags: []");
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
      JSON.stringify({ status: 'active', mission_id: 'MSN-DASHBOARD', tier: 'confidential' })
    );
    expect(readMissionDashboardState(statePath)).toEqual({
      status: 'active',
      mission_id: 'MSN-DASHBOARD',
      tier: 'confidential',
    });

    safeWriteFile(statePath, JSON.stringify({ status: 'active', mission_id: ['not-a-id'] }));
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
});
