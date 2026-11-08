import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  HEARING_TENANT,
  call,
  hr,
  sessionId,
  setUpHearing,
  storedHearing,
  tearDownHearing,
} from '../../../../test/hearing-route-harness';

// One real run per hand-off under SYSTEM_ROLE=concierge (kyberion-development-
// practices.md: a route moved between processes re-checks the role assumption
// policy and the path authority of every store it writes). The role
// assumptions and stores are real; only what cannot run here is replaced at
// its own boundary: the mission controller / alignment-request children (the
// spawn), the mission lookup they would have created, and the work-inventory
// decomposition's model call (deterministic, as in presence-studio's tests).
const spawn = vi.hoisted(() => ({
  calls: [] as Array<{ args: string[]; env?: Record<string, string | undefined> }>,
}));
vi.mock('@agent/core/secure-io', async (original) => {
  const actual = await original<typeof import('@agent/core/secure-io')>();
  // The built governed scripts the route checks for exist as after an operator build.
  const built = (target: unknown) =>
    /dist\/scripts\/mission_(controller|alignment_request)\.js$/u.test(String(target));
  return {
    ...actual,
    safeExistsSync: (...args: Parameters<typeof actual.safeExistsSync>) =>
      built(args[0]) || actual.safeExistsSync(...args),
    safeLstat: (...args: Parameters<typeof actual.safeLstat>) =>
      built(args[0])
        ? ({ isFile: () => true } as ReturnType<typeof actual.safeLstat>)
        : actual.safeLstat(...args),
    safeExecResult: (...args: Parameters<typeof actual.safeExecResult>) => {
      const argv = args[1] ?? [];
      if (argv[0] === 'dist/scripts/mission_controller.js') {
        spawn.calls.push({ args: argv, env: args[2]?.env as Record<string, string | undefined> });
        return { stdout: '', stderr: '', status: 0 };
      }
      if (argv[0] === 'dist/scripts/mission_alignment_request.js') {
        spawn.calls.push({ args: argv, env: args[2]?.env as Record<string, string | undefined> });
        return { stdout: JSON.stringify({ requestId: 'REQ-ALIGN-1' }), stderr: '', status: 0 };
      }
      return actual.safeExecResult(...args);
    },
  };
});
const mission = vi.hoisted(() => ({ dir: '', state: null as null | Record<string, unknown> }));
vi.mock('@agent/core/path-resolver', async (original) => {
  const actual = await original<typeof import('@agent/core/path-resolver')>();
  return { ...actual, findMissionPath: () => mission.dir || null };
});
vi.mock('@agent/core/mission/mission-state', async (original) => {
  const actual = await original<typeof import('@agent/core/mission/mission-state')>();
  return { ...actual, loadState: () => mission.state };
});
vi.mock('@agent/core/workforce/work-inventory-decompose', async (original) => {
  const actual = await original<typeof import('@agent/core/workforce/work-inventory-decompose')>();
  return {
    ...actual,
    proposeWorkDecomposition: (
      input: Parameters<typeof actual.proposeWorkDecomposition>[0],
      options: Parameters<typeof actual.proposeWorkDecomposition>[1]
    ) => actual.proposeWorkDecomposition(input, { ...options, useModel: false }),
  };
});
import {
  applyHearingTurn,
  createHearingRecord,
  hearingScenarioFromCatalogEntry,
  type HearingRecord,
} from '@agent/core/surface/hearing';
import { findHearingScenario } from '@agent/core/hearing-scenario-catalog';
import { hearingMissionId } from '@agent/core/surface/hearing-mission';

beforeAll(() => setUpHearing(), 120_000);
afterAll(() => tearDownHearing());

const NOW = '2026-11-08T00:00:00.000Z';

function answered(id: string, scenarioId?: string): HearingRecord {
  const entry = scenarioId ? findHearingScenario(scenarioId) : undefined;
  const scenario = entry ? hearingScenarioFromCatalogEntry(entry) : undefined;
  let record = createHearingRecord(id, NOW, scenario);
  for (const item of record.requirements)
    record = applyHearingTurn(
      record,
      { text: `answer for ${item.id}`, request_id: `turn-${item.id}` },
      NOW,
      scenario
    );
  return record;
}

function save(record: HearingRecord): void {
  hr.authority.withExecutionContext(
    'ecosystem_architect',
    () => hr.runtime.saveHearingRecord(HEARING_TENANT, record),
    undefined,
    HEARING_TENANT
  );
}

const scoped = (id: string, suffix = '') => `/api/hearing/${id}${suffix}?tenant=${HEARING_TENANT}`;

async function snapshot(id: string) {
  const res = await call('record', 'GET', scoped(id), { session: id });
  expect(res.status).toBe(200);
  const token = (res.body.record as { handoff_snapshot?: unknown }).handoff_snapshot;
  expect(token).toEqual({ version: 1, token: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  return token;
}

describe(
  'concierge /api/hearing hand-offs under SYSTEM_ROLE=concierge',
  { timeout: 120_000 },
  () => {
    it('decides an answered hearing as the owner member', async () => {
      const id = sessionId();
      save(answered(id));
      const res = await call(
        'decide',
        'POST',
        scoped(id, '/decide'),
        { session: id },
        {
          body: {},
        }
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.body.next_action).toMatchObject({
        kind: 'alignment_review',
        label_key: 'front_desk:hearing_next_alignment',
      });
      expect(storedHearing(HEARING_TENANT, id)?.decided_by).toMatchObject({
        kind: 'human',
        id: 'user:owner',
        role: 'owner',
      });
    });

    it('saves a decided work-inventory hearing as a confirmed tenant entry, idempotently', async () => {
      const id = sessionId();
      save({
        ...answered(id, 'work_inventory'),
        decided_by: { kind: 'human', id: 'user:owner', role: 'owner' },
        decided_at: NOW,
      });
      const handoff_snapshot = await snapshot(id);
      const res = await call(
        'inventory',
        'POST',
        scoped(id, '/inventory'),
        { session: id },
        {
          body: { handoff_snapshot },
        }
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        entry_id: expect.any(String),
        scope: { tenant_slug: HEARING_TENANT },
        // 仕事 › 依頼 is hosted here: a relative link carrying the tenant.
        next: { href: expect.stringMatching(new RegExp(`^/work\\?.*tenant=${HEARING_TENANT}`)) },
      });
      const work = await import('@agent/core/workforce/work-inventory');
      const entry = hr.authority.withExecutionContext(
        'ecosystem_architect',
        () =>
          work.loadWorkInventoryEntry({ tenant_slug: HEARING_TENANT }, String(res.body.entry_id)),
        undefined,
        HEARING_TENANT
      );
      expect(entry).toMatchObject({ status: 'confirmed', scope: { tenant_slug: HEARING_TENANT } });
      const replay = await call(
        'inventory',
        'POST',
        scoped(id, '/inventory'),
        { session: id },
        {
          body: { handoff_snapshot: await snapshot(id) },
        }
      );
      expect(replay.status).toBe(200);
      expect(replay.body.entry_id).toBe(res.body.entry_id);
    });

    it('hands a decided hearing off to a mission, bounding the children by SYSTEM_ROLE=concierge', async () => {
      const id = sessionId();
      const record: HearingRecord = {
        ...answered(id),
        decided_by: { kind: 'human', id: 'user:owner', role: 'owner' },
        decided_at: NOW,
      };
      save(record);
      const missionId = hearingMissionId(record, HEARING_TENANT);
      mission.dir = hr.io.pathResolver.sharedTmp('hearing-route-happy/' + missionId);
      mission.state = {
        mission_id: missionId,
        tenant_slug: HEARING_TENANT,
        tier: 'confidential',
        status: 'planned',
      };
      spawn.calls.length = 0;
      const handoff_snapshot = await snapshot(id);
      const res = await call(
        'handoff',
        'POST',
        scoped(id, '/handoff'),
        { session: id },
        {
          body: { handoff_snapshot },
        }
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        mission_id: missionId,
        approval_request_id: 'REQ-ALIGN-1',
        next_action: { kind: 'alignment_review', label_key: 'front_desk:hearing_open_decide' },
      });
      // Hosted on Concierge itself: the decide link is relative, never a crafted origin.
      expect(String((res.body.next_action as { href: string }).href)).toMatch(/^\/inbox(\?|$)/u);
      expect(spawn.calls.map((item) => item.args[0])).toEqual([
        'dist/scripts/mission_controller.js',
        'dist/scripts/mission_alignment_request.js',
      ]);
      // Both children inherit the server's own role (bounded by its policy).
      for (const item of spawn.calls) expect(item.env?.SYSTEM_ROLE).toBe('concierge');
      expect(spawn.calls[0].env?.KYBERION_TENANT).toBe(HEARING_TENANT);
      // The brief was written into the mission evidence under the real mission_controller role.
      const brief = hr.io.safeReadFile(mission.dir + '/evidence/mission-brief.json', {
        encoding: 'utf8',
      });
      expect(JSON.parse(String(brief))).toMatchObject({ missionId });
      const stored = storedHearing(HEARING_TENANT, id) as HearingRecord & {
        mission_id?: string;
        approval_request_id?: string;
      };
      expect(stored.mission_id).toBe(missionId);
      expect(stored.approval_request_id).toBe('REQ-ALIGN-1');
    });
  }
);
