import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { loadAuthorityRoleIndex } from './authority-role-registry.js';
import { loadAgentProfileDirectory } from './mission-team-index.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';

describe('mission-team-index governed loaders', () => {
  const rootDir = pathResolver.sharedTmp('mission-team-index-loader-tests');
  const authorityDirectoryRoot = pathResolver.sharedTmp('authority-role-registry-directory-test');
  const authoritySnapshotRoot = pathResolver.sharedTmp('authority-role-registry-snapshot-test');
  const profileDirectoryTarget = pathResolver.sharedTmp(
    'mission-team-index-profile-directory-target'
  );

  afterEach(() => {
    safeRmSync(rootDir, { recursive: true, force: true });
    safeRmSync(authorityDirectoryRoot, { recursive: true, force: true });
    safeRmSync(authoritySnapshotRoot, { recursive: true, force: true });
    safeRmSync(profileDirectoryTarget, { recursive: true, force: true });
  });

  it('rejects a schema-invalid agent profile directory entry', () => {
    const directory = path.join(rootDir, 'knowledge/product/orchestration/agent-profiles');
    safeMkdir(directory, { recursive: true });
    safeWriteFile(
      path.join(directory, 'attacker.json'),
      JSON.stringify({
        version: '1.0.0',
        agents: {
          attacker: {
            authority_roles: ['cyber_security'],
            team_roles: ['attacker'],
            // capabilities is required by agent-profile-index.schema.json.
          },
        },
      })
    );

    expect(() => loadAgentProfileDirectory(rootDir)).toThrow(/Invalid catalog agent-profile-index/);
  });

  it('rejects a symlinked agent profile directory before catalog loading', () => {
    const directory = path.join(rootDir, 'knowledge/product/orchestration/agent-profiles');
    safeMkdir(path.dirname(directory), { recursive: true });
    safeMkdir(profileDirectoryTarget, { recursive: true });
    safeSymlinkSync(profileDirectoryTarget, directory, 'dir');

    expect(() => loadAgentProfileDirectory(rootDir)).toThrow('[RESOURCE_PATH_SYMLINK]');
  });

  it('loads authority role directory entries through the dedicated schema', () => {
    const directory = path.join(
      authorityDirectoryRoot,
      'knowledge/product/governance/authority-roles'
    );
    safeMkdir(directory, { recursive: true });
    safeWriteFile(
      path.join(directory, 'reviewer.json'),
      JSON.stringify({
        role: 'reviewer',
        description: 'Independent reviewer',
        default_persona: 'analyst',
        write_scopes: [],
        scope_classes: ['quality_validation'],
        allowed_actuators: ['artifact-actuator'],
        tier_access: ['public'],
      })
    );

    expect(loadAuthorityRoleIndex(authorityDirectoryRoot)).toMatchObject({
      reviewer: {
        role: 'reviewer',
        scope_classes: ['quality_validation'],
      },
    });
  });

  it('falls back to the governed authority role snapshot when the directory is absent', () => {
    const directory = path.join(authoritySnapshotRoot, 'knowledge/product/governance');
    safeMkdir(directory, { recursive: true });
    safeWriteFile(
      path.join(directory, 'authority-role-index.json'),
      JSON.stringify({
        version: '1.0.0',
        authority_roles: {
          reviewer: {
            description: 'Snapshot reviewer',
            write_scopes: [],
            scope_classes: ['quality_validation'],
            allowed_actuators: ['artifact-actuator'],
            tier_access: ['public'],
          },
        },
      })
    );

    expect(loadAuthorityRoleIndex(authoritySnapshotRoot)).toMatchObject({
      reviewer: { description: 'Snapshot reviewer' },
    });
  });
});
