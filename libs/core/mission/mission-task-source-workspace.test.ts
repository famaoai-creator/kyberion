import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  role: 'mission_controller',
  scope: {} as Record<string, unknown>,
  state: {} as Record<string, unknown>,
  rows: [] as Array<Record<string, unknown>>,
  items: [] as Array<Record<string, unknown>>,
  clone: vi.fn(),
}));
vi.mock('../authority.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveRole: () => fixture.role,
}));
vi.mock('../scope-envelope.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  currentScopeEnvelope: () => undefined,
}));
vi.mock('../scope-context.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveScopeContext: () => fixture.scope,
}));
vi.mock('./mission-state.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadState: () => fixture.state,
}));
vi.mock('../governance/owner-scope.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveMissionDir: () => '/repo/active/missions/confidential/acme/MSN-PRIVATE',
}));
vi.mock('./mission-next-task-reader.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadMissionNextTaskObjectsAtPath: () => fixture.rows,
}));
vi.mock('../workforce/work-coordination.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkItems: () => fixture.items,
}));
vi.mock('./mission-development-workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureMissionDevelopmentSourceWorkspace: (...args: unknown[]) => fixture.clone(...args),
}));
vi.mock('./mission-lifecycle-completion.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writeMissionNextTasks: (
    _dir: string,
    update: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>
  ) => {
    fixture.rows = update(fixture.rows);
    return true;
  },
}));
import { prepareMissionTaskSourceWorkspace } from './mission-task-source-workspace.js';
const sha = 'a'.repeat(40);
beforeEach(() => {
  fixture.role = 'mission_controller';
  fixture.state = {
    mission_id: 'MSN-PRIVATE',
    status: 'active',
    tier: 'confidential',
    tenant_slug: 'acme',
    organization_id: 'org-a',
    relationships: { project: { project_id: 'project-a' } },
  };
  fixture.scope = {
    tier: 'confidential',
    tenant_slug: 'acme',
    organization_id: 'org-a',
    project_id: 'project-a',
  };
  fixture.rows = [
    {
      task_id: 'implement',
      status: 'planned',
      source_edit_paths: ['libs/core/example.ts'],
      source_edit_requires_approval: true,
    },
  ];
  fixture.items = [];
  fixture.clone.mockReset().mockImplementation((_state, _task, _paths, check) => {
    check();
    return {
      cwd: '/repo/private',
      sourcePaths: [
        'active/shared/runtime/workspaces/confidential/acme/development/example/libs/core/example.ts',
      ],
      created: true,
    };
  });
});
describe('ordinary private task workspace facade', () => {
  it('binds exact source paths without publishing or dropping approval and is idempotent', () => {
    expect(prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', sha).created).toBe(true);
    expect(fixture.rows[0]).toMatchObject({
      source_edit_requires_approval: true,
      source_workspace: {
        version: 1,
        baseline_commit: sha,
        source_paths: ['libs/core/example.ts'],
      },
    });
    fixture.clone.mockImplementation((_state, _task, _paths, check) => {
      check();
      return {
        cwd: '/repo/private',
        sourcePaths: fixture.rows[0].source_edit_paths,
        created: false,
      };
    });
    expect(prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', sha).created).toBe(false);
    expect(() =>
      prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', 'b'.repeat(40))
    ).toThrow(/baseline|contract/i);
  });
  it.each(['tier', 'tenant_slug', 'organization_id', 'project_id'])(
    'rejects mismatched %s before allocation',
    (key) => {
      fixture.scope[key] = 'foreign';
      expect(() => prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', sha)).toThrow(
        /scope/i
      );
      expect(fixture.clone).not.toHaveBeenCalled();
    }
  );
  it('requires controller authority and a private active undispatched planned task', () => {
    fixture.role = 'worker';
    expect(() => prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', sha)).toThrow(
      /controller/i
    );
    fixture.role = 'mission_controller';
    fixture.state.status = 'paused';
    expect(() => prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', sha)).toThrow(
      /active/i
    );
    fixture.state.status = 'active';
    fixture.rows[0].status = 'requested';
    expect(() => prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', sha)).toThrow(
      /planned/i
    );
    fixture.rows[0].status = 'planned';
    fixture.items = [{ context: { mission_id: 'MSN-PRIVATE', task_id: 'implement' } }];
    expect(() => prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', sha)).toThrow(
      /dispatch/i
    );
  });
  it('rejects changes during allocation before binding the board', () => {
    fixture.clone.mockImplementation((_state, _task, _paths, check) => {
      fixture.rows[0].source_edit_paths = ['libs/core/other.ts'];
      check();
    });
    expect(() => prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', sha)).toThrow(
      /changed/i
    );
    expect(fixture.rows[0].source_workspace).toBeUndefined();
  });
  it('rejects public missions and existing private paths as a new declaration', () => {
    fixture.state.tier = 'public';
    expect(() => prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', sha)).toThrow(
      /public/i
    );
    fixture.state.tier = 'confidential';
    fixture.rows[0].source_edit_paths = [
      'active/shared/runtime/workspaces/confidential/acme/foreign/libs/a.ts',
    ];
    expect(() => prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', sha)).toThrow();
    expect(fixture.clone).not.toHaveBeenCalled();
  });
  it.each(['mission_id', 'task_id'])('rejects an existing foreign %s binding', (field) => {
    fixture.scope[field] = 'foreign';
    expect(() => prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', sha)).toThrow(
      /scope/i
    );
    expect(fixture.clone).not.toHaveBeenCalled();
  });
  it('maps an exact source target and rejects a target outside the grant', () => {
    fixture.rows[0].target_path = 'libs/core/foreign.ts';
    expect(() => prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', sha)).toThrow(
      /target/i
    );
    expect(fixture.clone).not.toHaveBeenCalled();
    fixture.rows[0].target_path = 'libs/core/example.ts';
    const result = prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', sha);
    expect(fixture.rows[0].target_path).toBe(result.sourcePaths[0]);
  });
  it('keeps relationship-only organization scope authoritative', () => {
    delete fixture.state.organization_id;
    fixture.state.relationships = {
      organization: { organization_id: 'org-a' },
      project: { project_id: 'project-a' },
    };
    expect(prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', sha).created).toBe(true);
  });
  it('rejects prepared target drift before reusing the workspace', () => {
    prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', sha);
    fixture.rows[0].target_path = 'libs/core/example.ts';
    expect(() => prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', sha)).toThrow(
      /target/i
    );
    fixture.rows[0].target_path =
      'active/shared/runtime/workspaces/confidential/acme/foreign/libs/other.ts';
    expect(() => prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', sha)).toThrow(
      /target/i
    );
  });
  it.each(['HEAD', 'main', '../bad'])('rejects mutable baseline %s', (baseline) => {
    expect(() => prepareMissionTaskSourceWorkspace('MSN-PRIVATE', 'implement', baseline)).toThrow();
    expect(fixture.clone).not.toHaveBeenCalled();
  });
});
