import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { safeRmSync } from '@agent/core/secure-io';
import { projectRecordPath, saveProjectRecord } from '@agent/core/project/project-registry';
import { validateMissionStartCreateInput } from './mission-controller-args.js';

// relationships.project is the single source of project membership: a link must
// name a managed project, and the mission inherits the project's tenant and
// organization instead of silently dropping them.
const suffix = `${process.pid}-${Date.now().toString(36)}`.toUpperCase();
const PROJECT_ID = `PRJ-LINK-ARGS-${suffix}`;
const PROJECT_PATH = `active/shared/tmp/system/test-project-link/${suffix}`;
const savedEnv = { persona: process.env.KYBERION_PERSONA, role: process.env.MISSION_ROLE };

function argv(...extra: string[]): string[] {
  return [
    'node',
    'mission_controller.js',
    'create',
    'MSN-LINK-ARGS',
    '--tier',
    'public',
    '--project-id',
    PROJECT_ID,
    '--project-path',
    PROJECT_PATH,
    ...extra,
  ];
}

beforeEach(() => {
  process.env.KYBERION_PERSONA = 'ecosystem_architect';
  process.env.MISSION_ROLE = 'mission_controller';
});

afterEach(() => {
  safeRmSync(projectRecordPath(PROJECT_ID), { force: true });
  process.env.KYBERION_PERSONA = savedEnv.persona;
  process.env.MISSION_ROLE = savedEnv.role;
});

describe('mission → project link validation', () => {
  it('rejects a link to a project that does not exist', () => {
    expect(() => validateMissionStartCreateInput('create', 'MSN-LINK-ARGS', argv())).toThrow(
      `[PROJECT_LINK_INVALID] create MSN-LINK-ARGS: project not found: ${PROJECT_ID}`
    );
  });

  it('inherits the project organization and rejects a conflicting one', () => {
    saveProjectRecord({
      project_id: PROJECT_ID,
      name: 'Link args test',
      summary: 'Organization inheritance.',
      status: 'active',
      tier: 'public',
      organization_id: 'ORG-LINK-ARGS',
    } as Parameters<typeof saveProjectRecord>[0]);

    expect(validateMissionStartCreateInput('create', 'MSN-LINK-ARGS', argv()).organizationId).toBe(
      'ORG-LINK-ARGS'
    );
    expect(() =>
      validateMissionStartCreateInput(
        'create',
        'MSN-LINK-ARGS',
        argv('--organization-id', 'ORG-OTHER')
      )
    ).toThrow("organization 'ORG-OTHER' must match project organization 'ORG-LINK-ARGS'");
  });
});
