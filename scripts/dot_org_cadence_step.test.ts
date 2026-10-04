import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { DotCharter, LoadedDotCharter } from '@agent/core/dot/dot-charter';
import { dotStatePath } from '@agent/core/dot/dot-state-paths';
import { readJsonIfPresent } from '@agent/core/foundation/json';
import { safeRmSync } from '@agent/core/secure-io';
import {
  DOT_ORG_CADENCE_STATE_FILE,
  latestCronOccurrence,
  runDotOrgCadenceForCharter,
  runDotOrgCadenceStep,
  type CronScanMemo,
  type DotOrgCadenceDeps,
  type DotOrgCadenceState,
} from './dot_org_cadence_step.js';
import { DOT_SUPERVISOR_STEPS } from './dot_supervisor_extensions.js';

const CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'org-cadence-test',
  version: '1.0.0',
  title: 'Org cadence test',
  purpose: 'p',
  status: 'active',
  scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: 'org-a' },
  goal: { statement: 'g' },
  attention: { triggers: [{ kind: 'wake', channels: ['inbox'] }] },
  authority: { authority_role: 'organization_operator' },
  notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
  operations_cadence: {
    tick_every_minutes: 15,
    standup: { cron: '45 8 * * 1-5', timezone: 'Asia/Tokyo' },
    retro: { cron: '0 17 * * 5', timezone: 'Asia/Tokyo' },
  },
  runtime: { heartbeat_id: 'dot-org-cadence-test' },
};
const ACTIVE: LoadedDotCharter[] = [{ path: 'dots/org-cadence-test.json', charter: CHARTER }];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) safeRmSync(root, { recursive: true, force: true });
});

/** 2026-10-05 is a Monday; `jst` builds an instant from Asia/Tokyo wall time. */
const jst = (day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 9, day, hour - 9, minute));

type CadenceMocks = Record<'runAs' | 'budgetHard' | 'tick' | 'standup' | 'retro', Mock>;

function harness(overrides: Partial<CadenceMocks> = {}) {
  const rootDir = path.join(process.cwd(), `active/shared/tmp/dot-org-cadence-${randomUUID()}`);
  roots.push(rootDir);
  const deps: CadenceMocks & { rootDir: string; memo: CronScanMemo } = {
    rootDir,
    memo: new Map(),
    runAs: vi.fn(async (_c: DotCharter, fn: () => Promise<unknown>) => fn()),
    budgetHard: vi.fn(() => false),
    tick: vi.fn(async () => ({ failures: [] })),
    standup: vi.fn(() => ({})),
    retro: vi.fn(() => ({})),
    ...overrides,
  };
  const state = () =>
    readJsonIfPresent<DotOrgCadenceState>(
      path.join(rootDir, dotStatePath(CHARTER, DOT_ORG_CADENCE_STATE_FILE))
    );
  return { deps: deps satisfies DotOrgCadenceDeps, state };
}

describe('latestCronOccurrence', () => {
  it('finds the latest occurrence and resumes from the memo', () => {
    const memo = new Map();
    expect(latestCronOccurrence('45 8 * * 1-5', 'Asia/Tokyo', jst(7, 10), memo)).toEqual(
      jst(7, 8, 45)
    );
    // Next sweep resumes from the memo and still reports the same occurrence.
    expect(latestCronOccurrence('45 8 * * 1-5', 'Asia/Tokyo', jst(7, 10, 1), memo)).toEqual(
      jst(7, 8, 45)
    );
    // Saturday: the latest weekday occurrence is Friday's.
    expect(latestCronOccurrence('45 8 * * 1-5', 'Asia/Tokyo', jst(10, 12))).toEqual(jst(9, 8, 45));
  });
});

describe('runDotOrgCadenceForCharter', () => {
  it('runs the scoped tick when due and not again inside the interval', async () => {
    const { deps, state } = harness();
    const at = jst(5, 7, 0); // before the standup
    expect(await runDotOrgCadenceForCharter(CHARTER, at, ACTIVE, deps)).toContain('tick');
    expect(deps.tick).toHaveBeenCalledWith({
      scope: { tier: 'confidential', tenantSlug: 'acme', organizationId: 'org-a' },
      apply: true,
      now: at,
    });
    expect(deps.runAs).toHaveBeenCalledWith(CHARTER, expect.any(Function));
    expect(state()?.tick?.last_run_at).toBe(at.toISOString());

    await runDotOrgCadenceForCharter(CHARTER, jst(5, 7, 14), ACTIVE, deps);
    expect(deps.tick).toHaveBeenCalledTimes(1);
    await runDotOrgCadenceForCharter(CHARTER, jst(5, 7, 15), ACTIVE, deps);
    expect(deps.tick).toHaveBeenCalledTimes(2);
  });

  it('runs the standup once per occurrence', async () => {
    const { deps, state } = harness();
    await runDotOrgCadenceForCharter(CHARTER, jst(5, 8, 45), ACTIVE, deps);
    await runDotOrgCadenceForCharter(CHARTER, jst(5, 8, 46), ACTIVE, deps);
    await runDotOrgCadenceForCharter(CHARTER, jst(5, 12, 0), ACTIVE, deps);
    expect(deps.standup).toHaveBeenCalledTimes(1);
    expect(deps.standup).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { tier: 'confidential', tenantSlug: 'acme', organizationId: 'org-a' },
        timezone: 'Asia/Tokyo',
        persist: true,
      }),
      ACTIVE
    );
    expect(state()?.standup?.last_occurrence).toBe(jst(5, 8, 45).toISOString());
    await runDotOrgCadenceForCharter(CHARTER, jst(6, 8, 50), ACTIVE, deps);
    expect(deps.standup).toHaveBeenCalledTimes(2);
  });

  it('catches up at most one missed occurrence after downtime', async () => {
    const { deps } = harness();
    await runDotOrgCadenceForCharter(CHARTER, jst(5, 9, 0), ACTIVE, deps);
    expect(deps.standup).toHaveBeenCalledTimes(1);
    // Down Tuesday..Thursday morning: one catch-up run, not three.
    await runDotOrgCadenceForCharter(CHARTER, jst(8, 10, 0), ACTIVE, deps);
    await runDotOrgCadenceForCharter(CHARTER, jst(8, 10, 1), ACTIVE, deps);
    expect(deps.standup).toHaveBeenCalledTimes(2);
    // The first sweep caught up last Friday's retro once (inside the look-back).
    expect(deps.retro).toHaveBeenCalledTimes(1);
    await runDotOrgCadenceForCharter(CHARTER, jst(9, 16, 59), ACTIVE, deps);
    expect(deps.retro).toHaveBeenCalledTimes(1);
    await runDotOrgCadenceForCharter(CHARTER, jst(9, 17, 2), ACTIVE, deps);
    expect(deps.retro).toHaveBeenCalledTimes(2);
  });

  it('skips every cadence while the organization budget is at the hard limit', async () => {
    const { deps, state } = harness({ budgetHard: vi.fn(() => true) });
    expect(await runDotOrgCadenceForCharter(CHARTER, jst(5, 8, 45), ACTIVE, deps)).toEqual([]);
    expect(deps.tick).not.toHaveBeenCalled();
    expect(deps.standup).not.toHaveBeenCalled();
    expect(deps.runAs).not.toHaveBeenCalled();
    expect(state()).toBeNull();
  });

  it('ignores charters without an organization scope or cadence', async () => {
    const { deps } = harness();
    const { operations_cadence: _omit, ...plain } = CHARTER;
    await runDotOrgCadenceForCharter(plain as DotCharter, jst(5, 8, 45), ACTIVE, deps);
    await runDotOrgCadenceForCharter(
      { ...CHARTER, scope: { tier: 'confidential', tenant_slug: 'acme' } },
      jst(5, 8, 45),
      ACTIVE,
      deps
    );
    expect(deps.tick).not.toHaveBeenCalled();
    expect(deps.runAs).not.toHaveBeenCalled();
  });
});

describe('runDotOrgCadenceStep', () => {
  it('never throws and keeps the marker when a cadence fails', async () => {
    const { deps, state } = harness({
      tick: vi.fn(async () => {
        throw new Error('boom');
      }),
      standup: vi.fn(() => {
        throw new Error('[POLICY_VIOLATION] mismatch');
      }),
    });
    await expect(runDotOrgCadenceStep(jst(5, 8, 45), ACTIVE, deps)).resolves.toBeUndefined();
    expect(state()?.tick).toBeDefined();
    expect(state()?.standup?.last_occurrence).toBe(jst(5, 8, 45).toISOString());
    await runDotOrgCadenceStep(jst(5, 8, 46), ACTIVE, deps);
    expect(deps.tick).toHaveBeenCalledTimes(1);
    expect(deps.standup).toHaveBeenCalledTimes(1);
  });

  it('is registered as a supervisor step', () => {
    expect(DOT_SUPERVISOR_STEPS.map((step) => step.id)).toContain('dot-org-cadence');
  });
});
