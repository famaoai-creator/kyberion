/**
 * D1 (customer decision E2E): a finished bolt is archived under the
 * protected confidential archive tier. The decision case resolver reads it
 * bound to the tenant (no MISSION_ROLE needed), never for another tenant, only
 * that one state file, and a policy denial is a distinct error — never "not
 * found". Runs on a fresh fixture root with the real tier/tenant guard.
 */
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext as initialContext } from '../authority.js';
import { rootDir } from '../path-resolver.js';
import * as initialIO from '../secure-io.js';

const SOURCE_ROOT = rootDir();
const ROOT = path.join(SOURCE_ROOT, 'active/shared/tmp/cd-archived-state-' + process.pid);
const TENANT = 'cd-archstate';
const OTHER = 'cd-archstate-other';
const MISSION = 'MSN-CDARCH-OWN';
const FOREIGN = 'MSN-CDARCH-FOREIGN';
const EMPTY = 'MSN-CDARCH-EMPTY';
const savedRoot = process.env.KYBERION_ROOT;
const keys = [
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'MISSION_ID',
  'KYBERION_TENANT',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

let io: typeof import('../secure-io.js');
let authority: typeof import('../authority.js');
let core: typeof import('../core.js');
let lockModule: typeof import('./mission-decision-lock.js');
let resourceScope: typeof import('../foundation/resource-access-scope.js');

const archiveDir = (tenant: string, id: string) =>
  path.join(ROOT, 'active/archive/missions/confidential', tenant, id);

function state(id: string, tenant: string): string {
  return JSON.stringify({
    mission_id: id,
    tier: 'confidential',
    tenant_slug: tenant,
    status: 'archived',
    execution_mode: 'local',
    priority: 1,
    assigned_persona: 'tester',
    confidence_score: 1,
    git: { branch: 'test', start_commit: 'abc123', latest_commit: 'abc123', checkpoints: [] },
    history: [],
    relationships: { project: { project_id: 'PRJ-ARCH', relationship_type: 'belongs_to' } },
  });
}

function warnLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map(([line]) => String(line))
    .filter((line) => !line.startsWith('[locale]'));
}

beforeAll(async () => {
  initialContext('ecosystem_architect', () => {
    initialIO.safeWriteFile(path.join(ROOT, 'package.json'), '{"name":"cd-archstate-fixture"}');
    const copy = (relative: string): void => {
      for (const name of initialIO.safeReaddir(path.join(SOURCE_ROOT, relative))) {
        const file = path.join(relative, name);
        const source = path.join(SOURCE_ROOT, file);
        const stat = initialIO.safeLstat(source);
        if (stat.isSymbolicLink()) throw new Error('Linked governance fixture');
        if (stat.isDirectory()) copy(file);
        else if (/\.(?:json|yaml)$/u.test(name))
          initialIO.safeWriteFile(path.join(ROOT, file), initialIO.safeReadFile(source));
      }
    };
    copy('knowledge/product/governance');
    copy('knowledge/product/schemas');
    initialIO.safeMkdir(path.join(ROOT, 'active/shared/runtime'), { recursive: true });
  });
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  io = await import('../secure-io.js');
  authority = await import('../authority.js');
  core = await import('../core.js');
  lockModule = await import('./mission-decision-lock.js');
  resourceScope = await import('../foundation/resource-access-scope.js');
  expect((await import('../path-resolver.js')).rootDir()).toBe(ROOT);
  // Seeded as `finish` writes the archive: mission_controller, bound to the tenant.
  authority.withExecutionContext(
    'mission_controller',
    () => {
      const write = (id: string, file: string, text: string): void => {
        io.safeMkdir(archiveDir(TENANT, id), { recursive: true });
        io.safeWriteFile(path.join(archiveDir(TENANT, id), file), text);
      };
      write(MISSION, 'mission-state.json', state(MISSION, TENANT));
      write(MISSION, 'evidence.md', 'internal notes');
      // Filed under TENANT, but its state names OTHER.
      write(FOREIGN, 'mission-state.json', state(FOREIGN, OTHER));
      // An archive folder without a state file.
      write(EMPTY, 'notes.md', 'no state here');
    },
    undefined,
    TENANT
  );
}, 120_000);

beforeEach(() => {
  for (const key of keys) delete process.env[key];
});

afterEach(() => {
  for (const key of keys) delete process.env[key];
  vi.restoreAllMocks();
});

afterAll(() => {
  if (savedRoot === undefined) delete process.env.KYBERION_ROOT;
  else process.env.KYBERION_ROOT = savedRoot;
  initialContext('ecosystem_architect', () =>
    initialIO.safeRmSync(ROOT, { recursive: true, force: true })
  );
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('loadDecisionCaseMissionState (archived confidential tenant mission)', () => {
  it('the operator identity alone may not read the archive (why the bound read exists)', () => {
    expect(() =>
      io.safeReadFile(path.join(archiveDir(TENANT, MISSION), 'mission-state.json'), {
        encoding: 'utf8',
      })
    ).toThrow(/Higher tier required|SECURITY/u);
  });

  it('reads it for its own tenant without MISSION_ROLE', () => {
    const loaded = lockModule.loadDecisionCaseMissionState(MISSION, TENANT);
    expect(loaded?.status).toBe('archived');
    expect(loaded?.relationships?.project?.project_id).toBe('PRJ-ARCH');
  });

  it('is not visible to another tenant or without a tenant', () => {
    expect(lockModule.loadDecisionCaseMissionState(MISSION, OTHER)).toBeNull();
    expect(lockModule.loadDecisionCaseMissionState(MISSION)).toBeNull();
  });

  it('a state filed under tenant A that names tenant B is not returned', () => {
    expect(lockModule.loadDecisionCaseMissionState(FOREIGN, TENANT)).toBeNull();
    expect(lockModule.loadDecisionCaseMissionState(FOREIGN, OTHER)).toBeNull();
  });

  it('an archive folder without a state file is "not found", not an error', () => {
    expect(lockModule.loadDecisionCaseMissionState(EMPTY, TENANT)).toBeNull();
  });

  it('the capability opens only the state file: a sibling in the same folder stays unreadable', () => {
    const statePath = `active/archive/missions/confidential/${TENANT}/${MISSION}/mission-state.json`;
    const run = <T>(fn: () => T): T =>
      resourceScope.runInResourceAccessScope(
        lockModule.archivedMissionStateCapability(TENANT, statePath),
        () => authority.withExecutionContext('archived_mission_state_reader', fn, undefined, TENANT)
      );
    expect(
      String(run(() => io.safeReadFile(path.join(ROOT, statePath), { encoding: 'utf8' })))
    ).toContain(MISSION);
    expect(() =>
      run(() =>
        io.safeReadFile(path.join(archiveDir(TENANT, MISSION), 'evidence.md'), {
          encoding: 'utf8',
        })
      )
    ).toThrow(/RESOURCE_SCOPE_DENIED/u);
  });

  it('the reader role is read-only, needs its exact capability and is tenant-bound', () => {
    const role = 'archived_mission_state_reader';
    const statePath = `active/archive/missions/confidential/${TENANT}/${MISSION}/mission-state.json`;
    const capability = lockModule.archivedMissionStateCapability(TENANT, statePath);
    // No capability, or one bound to another tenant: refused at assumption.
    expect(() => authority.withExecutionContext(role, () => undefined, undefined, TENANT)).toThrow(
      /RESOURCE_SCOPE_REQUIRED/u
    );
    expect(() =>
      resourceScope.runInResourceAccessScope(capability, () =>
        authority.withExecutionContext(role, () => undefined, undefined, OTHER)
      )
    ).toThrow(/RESOURCE_SCOPE_REQUIRED|ROLE_TENANT_SCOPE/u);
    expect(() =>
      resourceScope.runInResourceAccessScope(capability, () =>
        authority.withExecutionContext(role, () => undefined)
      )
    ).toThrow(/ROLE_TENANT_SCOPE_REQUIRED/u);
    // The capability names only a tenant's own archived mission-state.json.
    expect(() =>
      lockModule.archivedMissionStateCapability(
        TENANT,
        `active/archive/missions/confidential/${OTHER}/${MISSION}/mission-state.json`
      )
    ).toThrow(/RESOURCE_SCOPE_INVALID/u);
    expect(() =>
      lockModule.archivedMissionStateCapability(
        TENANT,
        `active/missions/confidential/${TENANT}/${MISSION}/mission-state.json`
      )
    ).toThrow(/RESOURCE_SCOPE_INVALID/u);
    expect(() =>
      lockModule.archivedMissionStateCapability(
        TENANT,
        `active/archive/missions/confidential/${TENANT}/${MISSION}/evidence.md`
      )
    ).toThrow(/RESOURCE_SCOPE_INVALID/u);
    // Never a write, even of the file it may read.
    expect(() =>
      resourceScope.runInResourceAccessScope(capability, () =>
        authority.withExecutionContext(
          role,
          () => io.safeWriteFile(path.join(ROOT, statePath), state(MISSION, TENANT)),
          undefined,
          TENANT
        )
      )
    ).toThrow(/RESOURCE_SCOPE_REQUIRED|RESOURCE_SCOPE_DENIED/u);
  });

  it('a requested tenant never overrides the bound tenant (distinct error)', () => {
    process.env.KYBERION_TENANT = OTHER;
    const warn = vi.spyOn(core.logger, 'warn');
    expect(() => lockModule.loadDecisionCaseMissionState(MISSION, TENANT)).toThrow(
      /\[MISSION_STATE_TENANT_MISMATCH\]/u
    );
    expect(
      warnLines(warn).some((line) => /archived mission state not read — .+ \| .+/u.test(line))
    ).toBe(true);
  });

  it('a policy denial warns and throws MISSION_STATE_ACCESS_DENIED instead of "not found"', () => {
    // A surface that may assume no role (role-assumption-policy: customer_room).
    process.env.SYSTEM_ROLE = 'customer_room';
    const warn = vi.spyOn(core.logger, 'warn');
    expect(() => lockModule.loadDecisionCaseMissionState(MISSION, TENANT)).toThrow(
      /\[MISSION_STATE_ACCESS_DENIED\]/u
    );
    expect(
      warnLines(warn).some((line) => /archived mission state not readable — .+ \| .+/u.test(line))
    ).toBe(true);
  });
});
