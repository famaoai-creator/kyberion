import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { projectRecordPath, saveProjectRecord } from '@agent/core/project/project-registry';
import { withExecutionContextAsync } from '@agent/core/authority';
import { validateMissionStartCreateInput } from './mission-controller-args.js';

// relationships.project is the single source of project membership: a link must
// name a managed project, and the mission inherits the project's tenant and
// organization instead of silently dropping them.
const suffix = `${process.pid}-${Date.now().toString(36)}`.toUpperCase();
const PROJECT_ID = `PRJ-LINK-ARGS-${suffix}`;
const PROJECT_PATH = `active/shared/tmp/system/test-project-link/${suffix}`;
const savedEnv = { persona: process.env.KYBERION_BASE_ROLE, role: process.env.MISSION_ROLE };

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
  process.env.KYBERION_BASE_ROLE = 'ecosystem_architect';
  process.env.MISSION_ROLE = 'mission_controller';
});

afterEach(() => {
  safeRmSync(projectRecordPath(PROJECT_ID), { force: true });
  process.env.KYBERION_BASE_ROLE = savedEnv.persona;
  process.env.MISSION_ROLE = savedEnv.role;
  vi.unstubAllEnvs();
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
  it('blocks a missing confidential tenant in dry-run and execution', () => {
    vi.stubEnv('KYBERION_TENANT', '');
    vi.stubEnv('KYBERION_STANCE', '');
    vi.stubEnv('KYBERION_CUSTOMER', '');
    vi.stubEnv('KYBERION_TENANT_SCOPE_REQUIRED', 'strict');
    const args = ['create', 'MSN-LINK-ARGS', '--tier', 'confidential'];
    expect(
      validateMissionStartCreateInput('create', 'MSN-LINK-ARGS', [...args, '--dry-run']).preflight
    ).toMatchObject({ ready: false, issues: [expect.stringContaining('requires a tenant')] });
    expect(() => validateMissionStartCreateInput('create', 'MSN-LINK-ARGS', args)).toThrow(
      'requires a tenant'
    );
  });

  it('does not allow an explicit tenant to override the active tenant', () => {
    vi.stubEnv('KYBERION_TENANT', 'tenant-a');
    vi.stubEnv('KYBERION_STANCE', '');
    vi.stubEnv('KYBERION_CUSTOMER', '');
    const args = ['create', 'MSN-LINK-ARGS', '--tier', 'public', '--tenant-slug', 'tenant-b'];
    expect(() => validateMissionStartCreateInput('create', 'MSN-LINK-ARGS', args)).toThrow(
      'Tenant conflicts'
    );
  });

  it('requires values for explicitly supplied scope selectors', () => {
    expect(() =>
      validateMissionStartCreateInput('create', 'MSN-LINK-ARGS', [
        'create',
        'MSN-LINK-ARGS',
        '--tenant-slug',
        '--dry-run',
      ])
    ).toThrow('--tenant-slug requires a value');
  });

  it('does not inherit the shell tenant or Stance in a governed caller', async () => {
    vi.stubEnv('KYBERION_TENANT', 'tenant-a');
    vi.stubEnv('KYBERION_STANCE', 'unknown-shell-stance');
    const input = await withExecutionContextAsync(
      'mission_controller',
      () =>
        validateMissionStartCreateInput('create', 'MSN-LINK-ARGS', [
          'create',
          'MSN-LINK-ARGS',
          'public',
          '--tenant-slug',
          'tenant-b',
        ]),
      'ecosystem_architect',
      'tenant-b'
    );
    expect(input).toMatchObject({
      tier: 'public',
      tenantSlug: 'tenant-b',
      preflight: { ready: true },
    });
    expect(input.preflight?.stance).toBeUndefined();
  });

  it('refuses to add a tenant inside an explicitly tenant-free execution', async () => {
    await withExecutionContextAsync(
      'mission_controller',
      () => {
        expect(() =>
          validateMissionStartCreateInput('create', 'MSN-LINK-ARGS', [
            'create',
            'MSN-LINK-ARGS',
            '--tier',
            'public',
            '--tenant-slug',
            'tenant-b',
          ])
        ).toThrow('tenant-free governed execution scope');
      },
      'ecosystem_architect',
      ''
    );
  });

  it('requires the bound Project in a project-scoped execution', async () => {
    await withExecutionContextAsync(
      'mission_controller',
      () => {
        expect(() =>
          validateMissionStartCreateInput('create', 'MSN-LINK-ARGS', [
            'create',
            'MSN-LINK-ARGS',
            '--tier',
            'public',
          ])
        ).toThrow('Select its bound Project');
      },
      'ecosystem_architect',
      undefined,
      undefined,
      { projectId: PROJECT_ID }
    );
  });

  it('reports unfinished mission prerequisites during dry-run', () => {
    const input = validateMissionStartCreateInput('start', 'MSN-LINK-ARGS', [
      'start',
      'MSN-LINK-ARGS',
      'public',
      '--prerequisites',
      'MSN-NO-SUCH-PREREQUISITE',
      '--dry-run',
    ]);
    expect(input.preflight).toMatchObject({
      ready: false,
      issues: [expect.stringContaining('MISSION_PREREQUISITES_UNMET')],
    });
  });
  it('rechecks a planned Mission’s saved Project link when no Project flag is supplied', () => {
    const missionId = `MSN-SAVED-LINK-${suffix}`;
    const missionDir = pathResolver.missionDir(missionId, 'public');
    safeMkdir(missionDir, { recursive: true });
    try {
      safeWriteFile(
        `${missionDir}/mission-state.json`,
        JSON.stringify({
          mission_id: missionId,
          tier: 'public',
          status: 'planned',
          execution_mode: 'local',
          priority: 5,
          org_role: 'worker',
          confidence_score: 1,
          git: { branch: 'main', start_commit: 'abc', latest_commit: 'abc', checkpoints: [] },
          history: [],
          relationships: {
            project: { project_id: PROJECT_ID, relationship_type: 'belongs_to' },
          },
        })
      );
      const input = validateMissionStartCreateInput('start', missionId, [
        'start',
        missionId,
        '--dry-run',
      ]);
      expect(input.preflight?.ready).toBe(false);
      expect(input.preflight?.issues[0]).toContain('project not found');
    } finally {
      safeRmSync(missionDir, { recursive: true, force: true });
    }
  });

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
    const preview = validateMissionStartCreateInput(
      'create',
      'MSN-LINK-ARGS',
      argv('--organization-id', 'ORG-OTHER', '--dry-run')
    );
    expect(preview.preflight?.ready).toBe(false);
    expect(preview.preflight?.issues[0]).toContain('must match project organization');
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
