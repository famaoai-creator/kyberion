import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from './authority.js';
import { auditChain } from './audit-chain.js';
import { resetAgentIdentityServiceForTests } from './agent-identity.js';
import * as pathResolver from './path-resolver.js';
import {
  buildMissionLifecycleService,
  MissionLifecycleGovernedError,
  type MissionLifecycleUnderlyingSystem,
} from './mission-lifecycle-service.js';

/**
 * SO-01 facade tests. Two styles are used deliberately:
 *
 *  - Gate + audit-shape tests wrap a lightweight STUB system (only the ten
 *    verb methods the facade calls) so they exercise the facade's own new
 *    logic — the fail-closed gate and the shared audit record — in
 *    isolation from the underlying mission-* implementations, which already
 *    have their own suites (mission-creation.test.ts-equivalent coverage
 *    lives in mission-lifecycle.test.ts, mission-maintenance.test.ts, etc.).
 *  - The argv-independence test exercises the REAL `missionLifecycleService`
 *    (bound to the real missionSystem) end to end, because the landmine it
 *    regression-tests (mission-creation.ts reading `process.argv` directly)
 *    can only be proven wrong by observing real persisted mission state.
 */

function makeStubSystem(): MissionLifecycleUnderlyingSystem {
  return {
    create: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    createCheckpoint: vi.fn(async () => ({ ok: true }) as any),
    verifyMission: vi.fn(async () => undefined),
    finishMission: vi.fn(async () => undefined),
    staffMissionTeam: vi.fn(async () => ({ ok: true }) as any),
    prewarmMissionTeam: vi.fn(async () => ({ status: 'queued' }) as any),
    dispatchMissionWorkItems: vi.fn(async () => ({ ok: true }) as any),
    pauseMission: vi.fn(async () => undefined),
    resumeMission: vi.fn(async () => undefined),
    purgeMissions: vi.fn(async () => ({
      status: 'ok',
      adfPath: 'stub',
      dryRun: true,
      candidates: [],
      archived: [],
    })) as any,
  };
}

let previousMissionRole: string | undefined;
let previousPersona: string | undefined;

// NI-01 hermeticity: the argv-independence test below runs the REAL start()
// under mission_controller, whose staffing path provisions durable agent
// identities — point that ledger at a per-process tmp journal so this suite
// never writes the governed default path (mirrors how orchestrator-session
// tests repoint their own journal).
const IDENTITY_JOURNAL_TMP_DIR = `active/shared/tmp/mission-lifecycle-service-ni01-${process.pid}`;
let identityJournalCounter = 0;

beforeEach(() => {
  previousMissionRole = process.env.MISSION_ROLE;
  previousPersona = process.env.KYBERION_PERSONA;
  delete process.env.MISSION_ROLE;
  delete process.env.KYBERION_PERSONA;
  identityJournalCounter += 1;
  resetAgentIdentityServiceForTests(
    `${IDENTITY_JOURNAL_TMP_DIR}/agent-identities-${identityJournalCounter}.jsonl`
  );
});

afterEach(() => {
  if (previousMissionRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = previousMissionRole;
  if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
  else process.env.KYBERION_PERSONA = previousPersona;
  resetAgentIdentityServiceForTests();
});

afterAll(() => {
  const dir = pathResolver.rootResolve(IDENTITY_JOURNAL_TMP_DIR);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('mission-lifecycle-service — fail-closed execution-context gate', () => {
  const missionId = 'MSN-SO01-GATE-001';

  it.each([
    [
      'create',
      (facade: ReturnType<typeof buildMissionLifecycleService>) => facade.create(missionId),
    ],
    ['start', (facade: ReturnType<typeof buildMissionLifecycleService>) => facade.start(missionId)],
    [
      'createCheckpoint',
      (facade: ReturnType<typeof buildMissionLifecycleService>) =>
        facade.createCheckpoint('task-1', 'note', missionId),
    ],
    [
      'verify',
      (facade: ReturnType<typeof buildMissionLifecycleService>) =>
        facade.verify(missionId, 'verified', 'note'),
    ],
    [
      'finish',
      (facade: ReturnType<typeof buildMissionLifecycleService>) => facade.finish(missionId),
    ],
    ['staff', (facade: ReturnType<typeof buildMissionLifecycleService>) => facade.staff(missionId)],
    [
      'prewarm',
      (facade: ReturnType<typeof buildMissionLifecycleService>) => facade.prewarm(missionId),
    ],
    [
      'dispatch',
      (facade: ReturnType<typeof buildMissionLifecycleService>) => facade.dispatch(missionId),
    ],
    [
      'pause',
      (facade: ReturnType<typeof buildMissionLifecycleService>) => facade.pause(missionId, 'note'),
    ],
    [
      'resume',
      (facade: ReturnType<typeof buildMissionLifecycleService>) => facade.resume(missionId),
    ],
    [
      'archive',
      (facade: ReturnType<typeof buildMissionLifecycleService>) => facade.archive({ dryRun: true }),
    ],
  ] as const)(
    'verb "%s" throws MissionLifecycleGovernedError outside mission_controller context, and reaches the underlying system inside withExecutionContext',
    async (verb, invoke) => {
      const facade = buildMissionLifecycleService(makeStubSystem());

      // Outside any execution context (resolveRole() resolves to the test
      // runner's own process, never 'mission_controller') — fail closed.
      await expect(invoke(facade)).rejects.toThrow(MissionLifecycleGovernedError);
      await expect(invoke(facade)).rejects.toThrow(/requires mission_controller execution context/);

      // Inside withExecutionContext('mission_controller', ...) — the gate
      // passes and the call reaches the stub (no governed error).
      await expect(
        withExecutionContext('mission_controller', () => invoke(facade))
      ).resolves.not.toThrow();
    }
  );

  it('status is exempt from the gate (read-only, works outside any execution context)', () => {
    const facade = buildMissionLifecycleService(makeStubSystem());
    // Unknown mission id — must resolve to null, not throw a governed error.
    expect(() => facade.status('MSN-SO01-STATUS-DOES-NOT-EXIST')).not.toThrow();
    expect(facade.status('MSN-SO01-STATUS-DOES-NOT-EXIST')).toBeNull();
  });
});

describe('mission-lifecycle-service — shared audit record', () => {
  it('records exactly one auditChain.record per verb invocation, shaped {actor, surface, verb, mission}', async () => {
    const recordSpy = vi.spyOn(auditChain, 'record');
    const facade = buildMissionLifecycleService(makeStubSystem());
    recordSpy.mockClear();

    await withExecutionContext('mission_controller', () =>
      facade.pause('MSN-SO01-AUDIT-SHAPE-001', 'note', { surface: 'terminal' })
    );

    expect(recordSpy).toHaveBeenCalledTimes(1);
    const entry = recordSpy.mock.results[0]!.value;
    expect(Object.keys(entry.metadata).sort()).toEqual(['actor', 'mission', 'surface', 'verb']);
    expect(entry.metadata).toMatchObject({
      surface: 'terminal',
      verb: 'pause',
      mission: 'MSN-SO01-AUDIT-SHAPE-001',
    });
    expect(typeof entry.metadata.actor).toBe('string');
    expect(entry.metadata.actor.length).toBeGreaterThan(0);
  });

  it('defaults surface to "cli" when the caller does not tag it', async () => {
    const recordSpy = vi.spyOn(auditChain, 'record');
    const facade = buildMissionLifecycleService(makeStubSystem());
    recordSpy.mockClear();

    await withExecutionContext('mission_controller', () =>
      facade.resume('MSN-SO01-AUDIT-DEFAULT-001')
    );

    const entry = recordSpy.mock.results[0]!.value;
    expect(entry.metadata.surface).toBe('cli');
  });

  it('produces identically shaped {actor, surface, verb, mission} records for a CLI-style role (MISSION_ROLE env, as scripts/mission_controller.ts main() sets it) and a withExecutionContext surface-context call', async () => {
    const recordSpy = vi.spyOn(auditChain, 'record');
    const facade = buildMissionLifecycleService(makeStubSystem());
    recordSpy.mockClear();

    // CLI-context: mirrors scripts/mission_controller.ts main() — it sets
    // MISSION_ROLE='mission_controller' directly on process.env before any
    // verb dispatch, rather than calling withExecutionContext itself
    // (withExecutionContext is what the facade uses to grant surfaces the
    // same authority).
    process.env.MISSION_ROLE = 'mission_controller';
    await facade.pause('MSN-SO01-AUDIT-PARITY-CLI', 'cli note', { surface: 'cli' });
    delete process.env.MISSION_ROLE;

    // Surface-context: an in-process caller establishing the role via
    // withExecutionContext instead of inheriting it from the host process.
    await withExecutionContext('mission_controller', () =>
      facade.pause('MSN-SO01-AUDIT-PARITY-SURFACE', 'surface note', { surface: 'slack' })
    );

    expect(recordSpy).toHaveBeenCalledTimes(2);
    const cliEntry = recordSpy.mock.results[0]!.value;
    const surfaceEntry = recordSpy.mock.results[1]!.value;

    // Same shape (same keys) regardless of how the mission_controller role
    // was established.
    expect(Object.keys(cliEntry.metadata).sort()).toEqual(
      Object.keys(surfaceEntry.metadata).sort()
    );
    expect(Object.keys(cliEntry.metadata).sort()).toEqual(['actor', 'mission', 'surface', 'verb']);
    expect(cliEntry.metadata.verb).toBe('pause');
    expect(surfaceEntry.metadata.verb).toBe('pause');
    expect(cliEntry.metadata.surface).toBe('cli');
    expect(surfaceEntry.metadata.surface).toBe('slack');
    expect(typeof cliEntry.metadata.actor).toBe('string');
    expect(typeof surfaceEntry.metadata.actor).toBe('string');
  });
});

describe('mission-lifecycle-service — archive verb (AL-03)', () => {
  it('routes the policy-driven sweep to the underlying purgeMissions with the dry-run flag', async () => {
    const system = makeStubSystem();
    const facade = buildMissionLifecycleService(system);

    const dry = await withExecutionContext('mission_controller', () =>
      facade.archive({ dryRun: true })
    );
    expect(system.purgeMissions).toHaveBeenCalledWith(true);
    expect((dry as any).status).toBe('ok');

    await withExecutionContext('mission_controller', () => facade.archive());
    expect(system.purgeMissions).toHaveBeenLastCalledWith(false);
  });

  it('routes --mission targeting to archiveMissionById with the normalized id, without touching the sweep', async () => {
    const system = makeStubSystem();
    const archiveOne = vi.fn(async (mission: string) => ({
      status: 'archived' as const,
      mission,
    }));
    const facade = buildMissionLifecycleService(system, { archiveMissionById: archiveOne });

    const result = await withExecutionContext('mission_controller', () =>
      facade.archive({ missionId: 'msn-al03-target' })
    );

    expect(archiveOne).toHaveBeenCalledWith('MSN-AL03-TARGET');
    expect(system.purgeMissions).not.toHaveBeenCalled();
    expect((result as any).status).toBe('archived');
  });

  it('records the shared {actor, surface, verb, mission} audit record for archive', async () => {
    const recordSpy = vi.spyOn(auditChain, 'record');
    const facade = buildMissionLifecycleService(makeStubSystem(), {
      archiveMissionById: vi.fn(async (mission: string) => ({
        status: 'already_archived' as const,
        mission,
      })),
    });
    recordSpy.mockClear();

    await withExecutionContext('mission_controller', () =>
      facade.archive({ missionId: 'MSN-AL03-AUDIT-001', surface: 'cli' })
    );

    expect(recordSpy).toHaveBeenCalledTimes(1);
    const entry = recordSpy.mock.results[0]!.value;
    expect(Object.keys(entry.metadata).sort()).toEqual(['actor', 'mission', 'surface', 'verb']);
    expect(entry.metadata).toMatchObject({
      verb: 'archive',
      mission: 'MSN-AL03-AUDIT-001',
      surface: 'cli',
    });
    recordSpy.mockRestore();
  });
});

describe('mission-lifecycle-service — argv independence (SO-01 landmine regression)', () => {
  // mission-creation.ts used to read `process.argv.includes('--ephemeral')`
  // / `process.argv.indexOf('--intent-goal')` / `process.argv.includes('--force')`
  // directly, so ANY flag present anywhere on the host process's argv (e.g.
  // leftover from an unrelated CLI invocation sharing the process) silently
  // changed mission-creation/start behavior. SO-01 replaced those reads with
  // explicit options; this test proves `start` no longer depends on argv.
  const RUN_ID = Date.now();
  const CUSTOMER_SLUG = `so01-argv-${RUN_ID}`;
  const PROFILE_ROOT = path.join(pathResolver.rootDir(), 'customer', CUSTOMER_SLUG);
  const missionIdArgvPolluted = `MSN-SO01-ARGV-A-${RUN_ID}`;
  const missionIdArgvClean = `MSN-SO01-ARGV-B-${RUN_ID}`;
  let originalArgv: string[];
  let previousCustomer: string | undefined;

  function seedSovereignProfile(): void {
    fs.mkdirSync(PROFILE_ROOT, { recursive: true });
    fs.writeFileSync(
      path.join(PROFILE_ROOT, 'my-identity.json'),
      JSON.stringify({ sovereign: 'test', initialized_at: new Date().toISOString() }, null, 2)
    );
    fs.writeFileSync(
      path.join(PROFILE_ROOT, 'my-vision.md'),
      '# Sovereign Vision\n\nTest fixture vision.\n'
    );
    fs.writeFileSync(
      path.join(PROFILE_ROOT, 'agent-identity.json'),
      JSON.stringify({ agent_id: 'test-agent', version: '1.0.0', trust_tier: 'sovereign' }, null, 2)
    );
  }

  beforeEach(() => {
    originalArgv = process.argv;
    previousCustomer = process.env.KYBERION_CUSTOMER;
    process.env.KYBERION_CUSTOMER = CUSTOMER_SLUG;
    seedSovereignProfile();
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (previousCustomer === undefined) delete process.env.KYBERION_CUSTOMER;
    else process.env.KYBERION_CUSTOMER = previousCustomer;
    for (const id of [missionIdArgvPolluted, missionIdArgvClean]) {
      const missionPath = pathResolver.missionDir(id, 'public');
      fs.rmSync(missionPath, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    fs.rmSync(PROFILE_ROOT, { recursive: true, force: true });
  });

  it('start() behaves identically whether or not process.argv happens to contain --ephemeral/--force/--intent-goal', async () => {
    const { missionLifecycleService: realFacade } = await import('./mission-lifecycle-service.js');

    // Simulate a host process whose argv carries flags meant for a totally
    // different CLI invocation sharing the process (the historical bug: a
    // bare `process.argv.includes('--ephemeral')` read anywhere in the
    // process would see these).
    process.argv = [
      ...originalArgv,
      '--ephemeral',
      '--force',
      '--intent-goal',
      '/tmp/does-not-exist-and-must-not-be-read.json',
    ];
    // NOTE: `withExecutionContext` restores its env vars as soon as the
    // *synchronous* portion of the wrapped callback returns — it does not
    // survive across an `await` inside a multi-await async chain like the
    // real `start()` (checkPrerequisites → createMission → saveState, each
    // with their own awaits). That's a pre-existing characteristic of
    // env-var-scoped context, not something SO-01 changes. For a
    // long-running async CLI-equivalent operation, match how
    // scripts/mission_controller.ts main() actually establishes the role:
    // set MISSION_ROLE directly for the duration (the outer beforeEach/
    // afterEach in this file save and restore it).
    process.env.MISSION_ROLE = 'mission_controller';
    await realFacade.start(
      missionIdArgvPolluted,
      'public',
      'worker',
      'default',
      'development',
      undefined,
      {},
      undefined,
      {} // no explicit ephemeral/intentGoal/force — deterministic defaults
    );

    // Clean argv — no flags at all.
    process.argv = [...originalArgv];
    await realFacade.start(
      missionIdArgvClean,
      'public',
      'worker',
      'default',
      'development',
      undefined,
      {},
      undefined,
      {}
    );

    const { loadState } = await import('./mission-state.js');
    const pollutedState = loadState(missionIdArgvPolluted);
    const cleanState = loadState(missionIdArgvClean);

    expect(pollutedState).not.toBeNull();
    expect(cleanState).not.toBeNull();
    // Neither run must have picked up --ephemeral from an argv it never
    // explicitly opted into via options.
    expect((pollutedState as any).is_ephemeral).toBeFalsy();
    expect((cleanState as any).is_ephemeral).toBeFalsy();
    expect(pollutedState!.status).toBe(cleanState!.status);
    expect(pollutedState!.status).toBe('active');
  });
});
