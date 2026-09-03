import { beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeReaddir, safeRmSync } from './secure-io.js';
import {
  listProjectTrackRecords,
  listProjectTracksForProject,
  loadProjectTrackRecord,
  resolveProjectTrackRecordForText,
  saveProjectTrackRecord,
} from './project-track-registry.js';

function cleanupByPrefix(dir: string, prefix: string) {
  if (!safeExistsSync(dir)) return;
  for (const entry of safeReaddir(dir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.json')) continue;
    safeRmSync(`${dir}/${entry}`);
  }
}

describe('project-track-registry', () => {
  beforeEach(() => {
    cleanupByPrefix(pathResolver.shared('runtime/project-tracks'), 'TRK-TEST-');
  });

  it('persists and resolves project tracks', () => {
    saveProjectTrackRecord({
      track_id: 'TRK-TEST-REL1',
      project_id: 'PRJ-TEST-WEB',
      name: 'Release 1',
      summary: 'Primary SDLC release track',
      status: 'active',
      track_type: 'delivery',
      lifecycle_model: 'sdlc',
      tier: 'confidential',
      release_id: 'REL-1',
      required_artifacts: ['requirements-definition', 'test-plan'],
    });

    expect(loadProjectTrackRecord('TRK-TEST-REL1')?.name).toBe('Release 1');
    expect(listProjectTrackRecords().some((item) => item.track_id === 'TRK-TEST-REL1')).toBe(true);
    expect(listProjectTracksForProject('PRJ-TEST-WEB').length).toBe(1);
    expect(
      resolveProjectTrackRecordForText({
        projectId: 'PRJ-TEST-WEB',
        utterance: 'Release 1 のテスト計画を更新して',
      })?.track_id
    ).toBe('TRK-TEST-REL1');
  });

  it('persists the canonical track payload returned by the catalog', () => {
    saveProjectTrackRecord({
      track_id: 'TRK-TEST-CANONICAL',
      project_id: 'PRJ-TEST-WEB',
      name: 'Canonical Track',
      summary: 'Track metadata is canonicalized before persistence.',
      status: 'planned',
      track_type: 'research',
      lifecycle_model: 'research_cycle',
      tier: 'public',
      $schema: 'governance-metadata',
    } as unknown as Parameters<typeof saveProjectTrackRecord>[0]);

    const persisted = JSON.parse(
      String(
        safeReadFile(pathResolver.shared('runtime/project-tracks/TRK-TEST-CANONICAL.json'), {
          encoding: 'utf8',
        })
      )
    ) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('$schema');
    expect(persisted.track_id).toBe('TRK-TEST-CANONICAL');
  });

  it('rejects a track id that escapes the track directory', () => {
    expect(() => loadProjectTrackRecord('../outside')).toThrow(/escapes its directory/);
  });
});
