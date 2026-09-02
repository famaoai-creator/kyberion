import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('governance directory consistency loader boundary', () => {
  it('uses governed loaders for canonical snapshots where available', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check-governance-directory-consistency.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadAgentProfileSnapshot()');
    expect(source).toContain('loadTeamRoleDirectory()');
    expect(source).toContain('loadTeamRoleSnapshot()');
    expect(source).toContain('serviceEndpointsSnapshotCatalog.load()');
    expect(source).toContain("id: 'service-endpoints-snapshot'");
    expect(source).toContain('voiceProfileSnapshotCatalog.load()');
    expect(source).toContain('authorityRoleSnapshotCatalog.load()');
    expect(source).toContain('surfaceProviderSnapshotCatalog.load()');
    expect(source).toContain('specialistSnapshotCatalog.load()');
    expect(source).toContain('voiceEngineSnapshotCatalog.load()');
    expect(source).toContain('globalActuatorIndexSnapshotCatalog.load()');
    expect(source).toContain("id: 'global-actuator-index-snapshot'");
  });
});
