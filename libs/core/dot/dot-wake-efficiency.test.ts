import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { appendJsonLine } from '../foundation/json.js';
import type { DotCharter } from './dot-charter.js';
import {
  dotCronWakeIdleReason,
  readDotWakeLedger,
  recordDotWakeOutcome,
  runDotWake,
  type DotWakeLoopOptions,
  type DotWakeLoopResult,
  type DueDotTrigger,
} from './dot-runtime.js';
import { recordDotFeedback } from './dot-feedback.js';

const TEST_ROOT = 'active/shared/tmp/dot-wake-efficiency-tests';
const WATCH_REL = 'watch/alerts.jsonl';

const CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'idle-dot',
  version: '1.0.0',
  title: 'Idle dot',
  purpose: 'Keep the repository healthy.',
  status: 'active',
  scope: { tier: 'public' },
  goal: {
    statement: 'Keep CI green.',
    budget: { max_turns_per_wake: 4, wall_clock_ms_per_wake: 60_000, token_cap_per_day: 100_000 },
  },
  attention: { triggers: [{ kind: 'cron', cron: '0 * * * *', timezone: 'UTC' }] },
  authority: { authority_role: 'infrastructure_sentinel' },
  notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
  runtime: { heartbeat_id: 'dot-idle-dot', force_wake_every_ms: 6 * 3_600_000 },
};

const T0 = Date.parse('2026-10-02T10:00:00Z');
const at = (hours: number) => new Date(T0 + hours * 3_600_000);

function cronTrigger(when: Date): DueDotTrigger {
  return {
    trigger: { kind: 'cron', cron: '0 * * * *', timezone: 'UTC' },
    key: `cron:0 * * * *@${when.toISOString().slice(0, 16)}`,
    detail: 'cron 0 * * * * (UTC)',
  };
}

function result(): DotWakeLoopResult {
  return { finalState: 'complete', goal: { budgetStats: { tokensUsed: 10 } }, turnsRun: 1 };
}

function writeCharter(charter: DotCharter): string {
  safeMkdir(`${TEST_ROOT}/dots`, { recursive: true });
  safeWriteFile(`${TEST_ROOT}/dots/dot.json`, JSON.stringify(charter, null, 2) + '\n');
  return `${TEST_ROOT}/dots/dot.json`;
}

async function wakeAt(charter: DotCharter, when: Date, runLoop = vi.fn(async () => result())) {
  const receipt = await runDotWake(
    { path: writeCharter(charter), charter },
    {
      rootDir: TEST_ROOT,
      now: () => when,
      trigger: cronTrigger(when),
      runLoop,
      dispatch: () => [],
      hasRole: () => true,
    }
  );
  return { receipt, runLoop };
}

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('dot wake prompt shape', () => {
  it('sends the system framing once and a per-wake objective, as an event-handler goal', async () => {
    let seen: DotWakeLoopOptions | undefined;
    await wakeAt(
      CHARTER,
      at(0),
      vi.fn(async (options: DotWakeLoopOptions) => {
        seen = options;
        return result();
      })
    );
    expect(seen).toBeDefined();
    expect(seen!.systemPrompt).toContain('You are the resident dot "idle-dot"');
    expect(seen!.objective).not.toContain('You are the resident dot');
    expect(seen!.objective).toContain('Objective for this wake');
    expect(seen!.objective).toContain('Keep CI green.');
    expect(seen!.objective).toContain('goal_update with status "complete"');
    expect(seen!.objective).toContain(cronTrigger(at(0)).key);
    expect(seen!.completionMode).toBe('event_handler');
    expect(seen!.budgetGraceStep).toBe(false);
    expect(seen!.maxTurns).toBe(4);
  });
});

describe('idle cron wake pre-check', () => {
  it('skips an unchanged hourly cron wake without the model, then forces a real wake', async () => {
    const first = await wakeAt(CHARTER, at(0));
    expect(first.runLoop).toHaveBeenCalledTimes(1);

    const idle = await wakeAt(CHARTER, at(1));
    expect(idle.runLoop).not.toHaveBeenCalled();
    expect(idle.receipt.outcome).toBe('delivered');
    expect(idle.receipt.reason).toMatch(/^skipped_idle:/);
    const row = readDotWakeLedger({ rootDir: TEST_ROOT }).at(-1)!;
    expect(row).toMatchObject({ outcome: 'delivered', idle_skip: true, turns_run: 0 });
    // The heartbeat is still written, so the watchdog never sees an idle dot as stale.
    expect(safeExistsSync(`${TEST_ROOT}/active/shared/runtime/heartbeats`)).toBe(true);

    // Idle skips do not move the baseline: 6 h after the last REAL wake it wakes.
    expect((await wakeAt(CHARTER, at(5))).runLoop).not.toHaveBeenCalled();
    expect((await wakeAt(CHARTER, at(6))).runLoop).toHaveBeenCalledTimes(1);
  });

  it('wakes when the last real wake did not deliver', async () => {
    const trigger = cronTrigger(at(0));
    recordDotWakeOutcome(CHARTER, trigger, 'failed', {
      rootDir: TEST_ROOT,
      now: () => at(0),
      reason: 'backend down',
    });
    expect(
      dotCronWakeIdleReason(CHARTER, cronTrigger(at(1)), { rootDir: TEST_ROOT, now: () => at(1) })
    ).toBeUndefined();
  });

  it('wakes on new operator feedback since the last real wake', async () => {
    await wakeAt(CHARTER, at(0));
    const deps = { rootDir: TEST_ROOT, now: () => at(0.5) };
    recordDotFeedback(
      {
        dot_id: CHARTER.dot_id,
        action_id: 'dot_delegate_work',
        action_ref: 'a-1',
        outcome: 'approved',
        title: 't',
      },
      deps
    );
    expect(
      dotCronWakeIdleReason(CHARTER, cronTrigger(at(1)), { rootDir: TEST_ROOT, now: () => at(1) })
    ).toBeUndefined();
  });

  it('wakes on a pending watched-file change and never applies to non-cron triggers', async () => {
    const watching: DotCharter = {
      ...CHARTER,
      attention: {
        triggers: [
          { kind: 'cron', cron: '0 * * * *', timezone: 'UTC' },
          { kind: 'watch', paths: [WATCH_REL] },
        ],
      },
    };
    safeMkdir(`${TEST_ROOT}/watch`, { recursive: true });
    appendJsonLine(`${TEST_ROOT}/${WATCH_REL}`, { title: 'x' });
    await wakeAt(watching, at(0));
    const deps = { rootDir: TEST_ROOT, now: () => at(1) };
    // No snapshot was recorded for the watched path: a change is pending.
    expect(dotCronWakeIdleReason(watching, cronTrigger(at(1)), deps)).toBeUndefined();
    expect(
      dotCronWakeIdleReason(CHARTER, { trigger: { kind: 'followup' }, key: 'followup:x' }, deps)
    ).toBeUndefined();
  });
});
