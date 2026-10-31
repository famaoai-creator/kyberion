import { describe, expect, it } from 'vitest';
import {
  buildResidentServicesState,
  loadResidentServicesPolicy,
  planResidentServices,
  type DesiredResidentUnit,
  type ResidentServicesPolicy,
} from './resident-services.js';
import type { InstalledUnitDetail, InstalledUnitDetailsReport } from './installed-units.js';

const ID = 'ws-0123456789abcdef';
const ROOT = '/repos/mine';

const policy: ResidentServicesPolicy = {
  version: 1,
  services: [
    { id: 'chronos', requirement: 'required', rationale: 'r' },
    { id: 'daemon-watchdog', requirement: 'required', rationale: 'r' },
    { id: 'agent-runtime-supervisor', requirement: 'optional', rationale: 'r' },
    {
      id: 'generation-schedule',
      requirement: 'optional',
      owner_surface: 'generation-schedule',
      rationale: 'r',
    },
  ],
};

function desired(id: string, sha = `sha-${id}`, nodePath = '/opt/node'): DesiredResidentUnit {
  return {
    id,
    label: `com.kyberion.${id}.${ID}`,
    legacyLabel: `com.kyberion.${id}`,
    unitSha256: sha,
    nodePath,
  };
}

const DESIRED = Object.fromEntries(
  policy.services.map((service) => [service.id, desired(service.id)])
);

function unit(
  partial: Partial<InstalledUnitDetail> & Pick<InstalledUnitDetail, 'id'>
): InstalledUnitDetail {
  const scoped = partial.scope !== 'legacy';
  return {
    label: scoped ? `com.kyberion.${partial.id}.${ID}` : `com.kyberion.${partial.id}`,
    scope: 'scoped',
    repoRoot: ROOT,
    ownedByThisCheckout: true,
    loaded: true,
    unitPath: '/x',
    unitSha256: `sha-${partial.id}`,
    nodePath: '/opt/node',
    environment: {},
    instanceId: scoped ? ID : null,
    ...partial,
  };
}

function installed(units: InstalledUnitDetail[]): InstalledUnitDetailsReport {
  return { platform: 'darwin', instanceId: ID, repoRoot: ROOT, units };
}

function plan(
  units: InstalledUnitDetail[],
  extra: { surfaces?: string[]; include?: string[] } = {}
) {
  return planResidentServices({
    policy,
    installed: installed(units),
    enabledSurfaces: new Set(extra.surfaces ?? []),
    include: extra.include,
    desired: DESIRED,
  });
}

const actions = (result: ReturnType<typeof plan>) =>
  Object.fromEntries(result.items.map((item) => [item.id, item.action]));

describe('resident services planner', () => {
  it('installs required services on a clean host and leaves optional ones alone', () => {
    const result = plan([]);
    expect(actions(result)).toEqual({
      chronos: 'install',
      'daemon-watchdog': 'install',
      'agent-runtime-supervisor': 'not-requested',
      'generation-schedule': 'not-requested',
    });
    expect(result.pendingChanges).toBe(2);
  });

  it('is idempotent: current scoped units plan nothing', () => {
    const result = plan([unit({ id: 'chronos' }), unit({ id: 'daemon-watchdog' })]);
    expect(actions(result)).toMatchObject({ chronos: 'ok', 'daemon-watchdog': 'ok' });
    expect(result.pendingChanges).toBe(0);
  });

  it('migrates a legacy unit owned by this checkout', () => {
    const result = plan([
      unit({ id: 'chronos', scope: 'legacy' }),
      unit({ id: 'daemon-watchdog' }),
    ]);
    const chronos = result.items.find((item) => item.id === 'chronos')!;
    expect(chronos).toMatchObject({ action: 'migrate', legacyLabel: 'com.kyberion.chronos' });
    expect(result.pendingChanges).toBe(1);
  });

  it('never touches units of another checkout', () => {
    const foreign = unit({
      id: 'agent-runtime-supervisor',
      scope: 'legacy',
      repoRoot: '/repos/prod',
      ownedByThisCheckout: false,
    });
    const foreignChronos = unit({
      id: 'chronos',
      scope: 'legacy',
      repoRoot: '/repos/prod',
      ownedByThisCheckout: false,
    });
    const result = plan([foreign, foreignChronos], { include: ['agent-runtime-supervisor'] });
    // The foreign chronos does not count as installed here: this checkout still installs its own.
    expect(actions(result)).toMatchObject({
      chronos: 'install',
      'agent-runtime-supervisor': 'install',
    });
    expect(result.items.every((item) => item.legacyLabel === undefined)).toBe(true);
    expect(result.foreign.map((entry) => entry.label).sort()).toEqual([
      'com.kyberion.agent-runtime-supervisor',
      'com.kyberion.chronos',
    ]);
  });

  it('reinstalls when the unit hash or node path changed', () => {
    const result = plan([
      unit({ id: 'chronos', unitSha256: 'old' }),
      unit({ id: 'daemon-watchdog', nodePath: '/old/node' }),
    ]);
    expect(actions(result)).toMatchObject({ chronos: 'reinstall', 'daemon-watchdog': 'reinstall' });
    expect(result.items.find((item) => item.id === 'daemon-watchdog')!.reason).toContain(
      '/old/node'
    );
  });

  it('lets an enabled owner surface own the daemon and warns about a duplicate unit', () => {
    const result = plan([unit({ id: 'generation-schedule', scope: 'legacy' })], {
      surfaces: ['generation-schedule'],
      include: ['generation-schedule'],
    });
    const item = result.items.find((entry) => entry.id === 'generation-schedule')!;
    expect(item.action).toBe('surface-owned');
    expect(item.warnings[0]).toContain('--legacy-global');
    // Surface disabled → optional; --include installs (migrates) it.
    expect(actions(plan([], { include: ['generation-schedule'] }))['generation-schedule']).toBe(
      'install'
    );
    expect(actions(plan([]))['generation-schedule']).toBe('not-requested');
  });

  it('reports an optional legacy unit instead of migrating it unasked', () => {
    const result = plan([unit({ id: 'agent-runtime-supervisor', scope: 'legacy' })]);
    const item = result.items.find((entry) => entry.id === 'agent-runtime-supervisor')!;
    expect(item.action).toBe('not-requested');
    expect(item.warnings[0]).toContain('--include agent-runtime-supervisor');
  });

  it('rejects an unknown --include and lists undeclared units of this checkout', () => {
    expect(() => plan([], { include: ['nope'] })).toThrow('RESIDENT_SERVICE_UNKNOWN');
    expect(plan([unit({ id: 'mystery' })]).unmanaged).toEqual([
      { id: 'mystery', label: `com.kyberion.mystery.${ID}`, scope: 'scoped' },
    ]);
  });

  it('marks services unavailable when no unit can be rendered', () => {
    const result = planResidentServices({
      policy,
      installed: { ...installed([]), platform: 'win32', note: 'n' },
      enabledSurfaces: new Set(),
      desired: {},
    });
    expect(actions(result).chronos).toBe('unavailable');
    expect(result.pendingChanges).toBe(0);
    expect(result.note).toBe('n');
  });

  it('records installed services and keeps the stamp of unchanged ones', () => {
    const first = plan([unit({ id: 'daemon-watchdog' })]);
    const t1 = new Date('2026-11-01T00:00:00.000Z');
    const state1 = buildResidentServicesState({
      plan: first,
      desired: DESIRED,
      previous: null,
      changed: new Set(['chronos']),
      now: t1,
    });
    expect(state1.services.map((entry) => entry.id)).toEqual(['chronos', 'daemon-watchdog']);
    const second = plan([unit({ id: 'chronos' }), unit({ id: 'daemon-watchdog' })]);
    const state2 = buildResidentServicesState({
      plan: second,
      desired: DESIRED,
      previous: state1,
      changed: new Set(),
      now: new Date('2026-11-02T00:00:00.000Z'),
    });
    expect(state2.services.find((entry) => entry.id === 'chronos')!.installed_at).toBe(
      t1.toISOString()
    );
    expect(state2).toMatchObject({ instance_id: ID, repo_root: ROOT });
  });

  it('loads the governed policy (chronos + watchdog required)', () => {
    const governed = loadResidentServicesPolicy();
    const requirement = Object.fromEntries(
      governed.services.map((service) => [service.id, service.requirement])
    );
    expect(requirement).toEqual({
      chronos: 'required',
      'daemon-watchdog': 'required',
      'agent-runtime-supervisor': 'optional',
      'generation-schedule': 'optional',
    });
    expect(
      governed.services.find((service) => service.id === 'generation-schedule')!.owner_surface
    ).toBe('generation-schedule');
  });
});
