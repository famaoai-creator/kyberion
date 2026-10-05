import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { safeMkdir, safeRmSync } from '@agent/core/secure-io';
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

function argvWithoutPath(): string[] {
  return [
    'node',
    'mission_controller.js',
    'create',
    'MSN-LINK-ARGS',
    '--tier',
    'public',
    '--project-id',
    PROJECT_ID,
  ];
}

describe('mission → project link validation', () => {
  it('derives --project-path from the project record when it is omitted', () => {
    saveProjectRecord({
      project_id: PROJECT_ID,
      name: 'Link args test',
      summary: 'Path derivation.',
      status: 'active',
      tier: 'public',
      project_os_path: PROJECT_PATH,
    } as Parameters<typeof saveProjectRecord>[0]);

    expect(() =>
      validateMissionStartCreateInput('create', 'MSN-LINK-ARGS', argvWithoutPath())
    ).toThrow(`Create it with \`pnpm project scaffold ${PROJECT_ID}\`, or pass --project-path.`);

    safeMkdir(PROJECT_PATH, { recursive: true });
    try {
      const input = validateMissionStartCreateInput('create', 'MSN-LINK-ARGS', argvWithoutPath());
      expect(input.relationships?.project?.project_path).toBe(PROJECT_PATH);
      expect(input.ledgerTargets?.markdown).toContain('mission-ledger.md');
    } finally {
      safeRmSync(PROJECT_PATH, { recursive: true, force: true });
    }
  });

  it('rejects a link to a project that does not exist', () => {
    expect(() => validateMissionStartCreateInput('create', 'MSN-LINK-ARGS', argv())).toThrow(
      `[PROJECT_LINK_INVALID] create MSN-LINK-ARGS: project not found: ${PROJECT_ID}`
    );
  });

  it('downgrades an unregistered project to a warning in --dry-run', () => {
    // A dry-run plan may preview `project create --dry-run` and the linked
    // mission together; only the real run requires the record to exist.
    const input = validateMissionStartCreateInput('create', 'MSN-LINK-ARGS', argv('--dry-run'));
    expect(input.projectLinkWarning).toContain(
      `[PROJECT_LINK_INVALID] create MSN-LINK-ARGS: project not found: ${PROJECT_ID}`
    );
    expect(input.relationships?.project?.project_id).toBe(PROJECT_ID);
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

  it('inherits the project tier and tenant when they are not given', () => {
    saveProjectRecord({
      project_id: PROJECT_ID,
      name: 'Link args test',
      summary: 'Tier/tenant inheritance.',
      status: 'active',
      tier: 'public',
      tenant_slug: 'tenant-link',
    } as Parameters<typeof saveProjectRecord>[0]);
    const withoutTier = [
      'node',
      'mission_controller.js',
      'create',
      'MSN-LINK-ARGS',
      '--project-id',
      PROJECT_ID,
      '--project-path',
      PROJECT_PATH,
    ];
    const input = validateMissionStartCreateInput('create', 'MSN-LINK-ARGS', withoutTier);
    expect(input.tier).toBe('public');
    // The legacy positional tenantId ('default') is not a stated tenant.
    const withLegacyDefault = validateMissionStartCreateInput('create', 'MSN-LINK-ARGS', [
      'node',
      'mission_controller.js',
      'create',
      'MSN-LINK-ARGS',
      'public',
      'default',
      '--project-id',
      PROJECT_ID,
      '--project-path',
      PROJECT_PATH,
    ]);
    expect(withLegacyDefault.tenantSlug).toBe('tenant-link');
    expect(input.tenantSlug).toBe('tenant-link');
  });
});
