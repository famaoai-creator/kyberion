import path from 'node:path';
import AjvModule from 'ajv';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeExistsSync, safeRmSync } from './secure-io.js';
import {
  listProjectOperationalStates,
  loadProjectOperationalState,
  projectOperationalMissionLinkPath,
  projectOperationalStateDir,
  projectOperationalStatePath,
  projectOperationalTrackStatePath,
  saveProjectMissionLink,
  saveProjectOperationalState,
  saveProjectTrackState,
} from './project-operational-state-registry.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

const ORIGINAL_PERSONA = process.env.KYBERION_PERSONA;
const ORIGINAL_ROLE = process.env.MISSION_ROLE;

function cleanupWorkspace(projectId: string, tier: 'personal' | 'confidential' | 'public', tenantSlug = 'shared') {
  const workspace = pathResolver.projectWorkspaceDir(projectId, tier, tenantSlug);
  if (safeExistsSync(workspace)) {
    safeRmSync(workspace);
  }
}

describe('project-operational-state-registry', () => {
  beforeEach(() => {
    process.env.KYBERION_PERSONA = 'worker';
    process.env.MISSION_ROLE = 'software_developer';
    cleanupWorkspace('PRJ-TEST-OPS', 'public', 'tenant-alpha');
    cleanupWorkspace('PRJ-TEST-OPS-2', 'confidential', 'shared');
  });

  afterEach(() => {
    process.env.KYBERION_PERSONA = ORIGINAL_PERSONA;
    process.env.MISSION_ROLE = ORIGINAL_ROLE;
  });

  it('persists and resolves operational state under active/projects tier and tenant scopes', () => {
    const filePath = saveProjectOperationalState({
      project_id: 'PRJ-TEST-OPS',
      name: 'Test Project OS',
      summary: 'Live project state for tenant-aware storage.',
      status: 'active',
      tier: 'public',
      tenant_slug: 'tenant-alpha',
      current_phase: 'build',
      active_track_ids: ['TRK-TEST-REL1'],
      active_mission_ids: ['MSN-TEST-001'],
      active_task_session_ids: ['TSK-TEST-001'],
      source_refs: ['mission:MSN-TEST-001', 'track:TRK-TEST-REL1'],
      sources: [
        {
          kind: 'mission',
          ref: 'mission:MSN-TEST-001',
          summary: 'Implementation mission is active.',
          captured_at: '2026-06-05T00:00:00.000Z',
        },
      ],
      distill_targets: ['knowledge/product/evolution/projects/PRJ-TEST-OPS/overview.md'],
      knowledge_refs: ['knowledge/product/evolution/projects/PRJ-TEST-OPS/overview.md'],
      metadata: { owner: 'team-alpha' },
    });

    expect(filePath).toContain(path.join('active', 'projects', 'public', 'tenant-alpha', 'PRJ-TEST-OPS', 'state', 'project-state.json'));
    expect(projectOperationalStatePath('PRJ-TEST-OPS', 'public', 'tenant-alpha')).toBe(filePath);
    expect(projectOperationalStateDir('PRJ-TEST-OPS', 'public', 'tenant-alpha')).toContain(path.join('active', 'projects', 'public', 'tenant-alpha', 'PRJ-TEST-OPS', 'state'));
    expect(loadProjectOperationalState('PRJ-TEST-OPS', { tier: 'public', tenantSlug: 'tenant-alpha' })?.current_phase).toBe('build');
    expect(loadProjectOperationalState('PRJ-TEST-OPS')?.tenant_slug).toBe('tenant-alpha');
    expect(listProjectOperationalStates({ tier: 'public', tenantSlug: 'tenant-alpha' })).toHaveLength(1);

    const missionLink = saveProjectMissionLink({
      project_id: 'PRJ-TEST-OPS',
      tier: 'public',
      tenant_slug: 'tenant-alpha',
      mission_id: 'MSN-TEST-001',
      relationship_type: 'primary',
      summary: 'Main implementation mission',
      status: 'active',
      evidence_refs: ['evidence:dispatch-proof'],
    });
    const trackState = saveProjectTrackState({
      project_id: 'PRJ-TEST-OPS',
      tier: 'public',
      tenant_slug: 'tenant-alpha',
      track_id: 'TRK-TEST-REL1',
      name: 'Release 1',
      summary: 'Primary delivery track',
      status: 'active',
      lifecycle_model: 'sdlc',
      required_artifacts: ['requirements-definition', 'test-plan'],
      active_mission_ids: ['MSN-TEST-001'],
    });

    expect(missionLink).toBe(projectOperationalMissionLinkPath('PRJ-TEST-OPS', 'public', 'tenant-alpha', 'MSN-TEST-001'));
    expect(trackState).toBe(projectOperationalTrackStatePath('PRJ-TEST-OPS', 'public', 'tenant-alpha', 'TRK-TEST-REL1'));
    expect(safeExistsSync(missionLink)).toBe(true);
    expect(safeExistsSync(trackState)).toBe(true);
  });

  it('emits project operational state records that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(pathResolver.rootDir(), 'knowledge/product/schemas/project-operational-state.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const valid = validate({
      project_id: 'PRJ-TEST-SCHEMA',
      name: 'Schema Project OS',
      summary: 'Schema validation fixture.',
      status: 'active',
      tier: 'confidential',
      tenant_slug: 'tenant-beta',
      current_phase: 'design',
      active_track_ids: ['TRK-TEST-SCHEMA'],
      active_mission_ids: ['MSN-TEST-SCHEMA'],
      active_task_session_ids: ['TSK-TEST-SCHEMA'],
      source_refs: ['mission:MSN-TEST-SCHEMA'],
      sources: [
        {
          kind: 'track',
          ref: 'track:TRK-TEST-SCHEMA',
        },
      ],
      distill_targets: ['knowledge/product/evolution/projects/PRJ-TEST-SCHEMA/summary.md'],
      knowledge_refs: ['knowledge/product/evolution/projects/PRJ-TEST-SCHEMA/summary.md'],
      updated_at: new Date('2026-06-05T00:00:00.000Z').toISOString(),
    });
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });
});
