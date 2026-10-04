import { afterEach, describe, expect, it } from 'vitest';
import { appendJsonLine } from '../foundation/json.js';
import { safeMkdir, safeRmSync } from '../secure-io.js';
import type { DotCharter } from './dot-charter.js';
import { DOT_PROMPT_SECTIONS, DOT_WAKE_TOOLS } from './dot-extension-registry.js';
import {
  DOT_FOLLOWUP_WAKE_LEDGER_PATH,
  dotCronMinuteKey,
  dotFollowupsPromptSection,
  dotScheduleFollowupTool,
  evaluateDotCronCatchUp,
  evaluateDotFollowupsDue,
  listPendingDotFollowups,
  parseDotFollowup,
} from './dot-followups.js';
import { DOT_WAKE_LEDGER_PATH, evaluateDotTriggersDue } from './dot-runtime.js';
import './dot-extension-bootstrap.js';
import { DOT_FOLLOWUPS_FILE, dotStatePath } from './dot-state-paths.js';

const TEST_ROOT = 'active/shared/tmp/dot-followups-tests';
const T0 = new Date('2026-10-05T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const CHARTER = {
  kind: 'dot-charter',
  dot_id: 'fu-dot',
  scope: { tier: 'public' },
  attention: { triggers: [{ kind: 'cron', cron: '0 * * * *', timezone: 'UTC' }] },
  runtime: { heartbeat_id: 'x' },
} as unknown as DotCharter;

afterEach(() => safeRmSync(TEST_ROOT, { recursive: true, force: true }));

const ctx = (now: Date) => ({ rootDir: TEST_ROOT, now: () => now });
function ledger(row: Record<string, unknown>): void {
  safeMkdir(`${TEST_ROOT}/active/shared/runtime`, { recursive: true });
  appendJsonLine(`${TEST_ROOT}/${DOT_WAKE_LEDGER_PATH}`, {
    dot_id: 'fu-dot',
    kind: 'cron',
    ...row,
  });
}

describe('contract with dot-runtime', () => {
  it('registers tool + section', () => {
    expect(DOT_WAKE_TOOLS.map((t) => t.name)).toContain('dot_schedule_followup');
    expect(DOT_PROMPT_SECTIONS.map((s) => s.id)).toContain('dot-followups');
  });
  it('mirrors the wake ledger path', () => {
    expect(DOT_FOLLOWUP_WAKE_LEDGER_PATH).toBe(DOT_WAKE_LEDGER_PATH);
  });
  it('shares the cron key space with evaluateDotTriggersDue', () => {
    const [normal] = evaluateDotTriggersDue(CHARTER, ctx(T0));
    expect(normal.key).toBe(`cron:0 * * * *@${dotCronMinuteKey(T0, 'UTC')}`);
  });
});

describe('follow-ups', () => {
  it('parses with clamping', () => {
    expect(parseDotFollowup({ delay_minutes: 1, reason: 'r' })).toMatchObject({
      value: { delay_minutes: 5 },
    });
    expect(parseDotFollowup({ delay_minutes: 1e9, reason: 'r' })).toMatchObject({
      value: { delay_minutes: 10080 },
    });
    expect(parseDotFollowup({ delay_minutes: 10 }).ok).toBe(false);
  });

  it('schedules, becomes due, and is consumed by a delivered row', () => {
    expect(
      dotScheduleFollowupTool.apply(CHARTER, [{ delay_minutes: 30, reason: 'recheck CI' }], ctx(T0))
    ).toEqual([]);
    expect(evaluateDotFollowupsDue(CHARTER, ctx(at(10)))).toEqual([]);
    const [due] = evaluateDotFollowupsDue(CHARTER, ctx(at(31)));
    expect(due.trigger.kind).toBe('followup');
    expect(due.key).toMatch(/^followup:fu-/);
    expect(due.detail).toContain('recheck CI');
    expect(dotFollowupsPromptSection.lines(CHARTER, ctx(at(31))).join('\n')).toContain(
      'recheck CI'
    );
    ledger({ trigger_key: due.key, fired_at: at(32).toISOString(), outcome: 'delivered' });
    expect(evaluateDotFollowupsDue(CHARTER, ctx(at(40)))).toEqual([]);
    expect(listPendingDotFollowups(CHARTER, ctx(at(40)))).toEqual([]);
  });

  it('retries a failed follow-up only after backoff', () => {
    dotScheduleFollowupTool.apply(CHARTER, [{ delay_minutes: 5, reason: 'r' }], ctx(T0));
    const [due] = evaluateDotFollowupsDue(CHARTER, ctx(at(6)));
    ledger({ trigger_key: due.key, fired_at: at(6).toISOString(), outcome: 'failed' });
    expect(evaluateDotFollowupsDue(CHARTER, ctx(at(8)))).toEqual([]);
    expect(evaluateDotFollowupsDue(CHARTER, ctx(at(12)))).toHaveLength(1);
  });

  it('caps pending (default 3, charter override)', () => {
    const first = dotScheduleFollowupTool.apply(
      CHARTER,
      [1, 2].map((n) => ({ delay_minutes: 10 * n, reason: `r${n}` })),
      ctx(T0)
    );
    expect(first).toEqual([]);
    const more = dotScheduleFollowupTool.apply(
      CHARTER,
      [3, 4].map((n) => ({ delay_minutes: 10 * n, reason: `r${n}` })),
      ctx(at(1))
    );
    expect(more).toHaveLength(1);
    expect(listPendingDotFollowups(CHARTER, ctx(at(2)))).toHaveLength(3);
    const one = { ...CHARTER, followups: { max_pending: 1 } } as DotCharter;
    expect(
      dotScheduleFollowupTool.apply(one, [{ delay_minutes: 10, reason: 'x' }], ctx(at(2)))
    ).toHaveLength(1);
  });

  it('atomically replaces only the completing follow-up and does not re-arm on a retry', () => {
    const one = { ...CHARTER, followups: { max_pending: 1 } } as DotCharter;
    dotScheduleFollowupTool.apply(one, [{ delay_minutes: 5, reason: 'first' }], ctx(T0));
    const [due] = evaluateDotFollowupsDue(one, ctx(at(6)));
    expect(
      dotScheduleFollowupTool.apply(one, [{ delay_minutes: 5, reason: 'wrong key' }], {
        ...ctx(at(6)),
        completingFollowupKey: 'followup:other',
      })
    ).toHaveLength(1);
    expect(
      dotScheduleFollowupTool.apply(one, [{ delay_minutes: 5, reason: 'replacement' }], {
        ...ctx(at(6)),
        completingFollowupKey: due.key,
      })
    ).toEqual([]);
    // Successor commitment itself consumes the parent even if delivery is not recorded.
    expect(listPendingDotFollowups(one, ctx(at(6))).map((row) => row.reason)).toEqual([
      'replacement',
    ]);
    const [replacement] = listPendingDotFollowups(one, ctx(at(6)));
    expect(
      dotScheduleFollowupTool.apply(one, [{ delay_minutes: 20, reason: 'duplicate retry' }], {
        ...ctx(at(12)),
        completingFollowupKey: due.key,
      })
    ).toEqual([]);
    expect(listPendingDotFollowups(one, ctx(at(12)))).toEqual([replacement]);
    ledger({ trigger_key: due.key, fired_at: at(6).toISOString(), outcome: 'delivered' });
    expect(listPendingDotFollowups(one, ctx(at(6))).map((row) => row.reason)).toEqual([
      'replacement',
    ]);
  });

  it('does not treat a malformed successor as a committed replacement', () => {
    const one = { ...CHARTER, followups: { max_pending: 1 } } as DotCharter;
    dotScheduleFollowupTool.apply(one, [{ delay_minutes: 5, reason: 'original' }], ctx(T0));
    const [due] = evaluateDotFollowupsDue(one, ctx(at(6)));
    appendJsonLine(`${TEST_ROOT}/${dotStatePath(one, DOT_FOLLOWUPS_FILE)}`, {
      dot_id: one.dot_id,
      followup_id: 'broken-successor',
      replaces_followup_id: due.key.slice('followup:'.length),
      due_at: 'not-a-date',
      reason: 'broken',
      created_at: T0.toISOString(),
    });
    expect(listPendingDotFollowups(one, ctx(at(6))).map((row) => row.reason)).toEqual(['original']);
    expect(
      dotScheduleFollowupTool.apply(one, [{ delay_minutes: 10, reason: 'valid successor' }], {
        ...ctx(at(6)),
        completingFollowupKey: due.key,
      })
    ).toEqual([]);
    expect(listPendingDotFollowups(one, ctx(at(6))).map((row) => row.reason)).toEqual([
      'valid successor',
    ]);
  });
});

describe('cron catch-up', () => {
  const delivered = (min: number) =>
    ledger({
      trigger_key: `cron:0 * * * *@${dotCronMinuteKey(at(min), 'UTC')}`,
      fired_at: at(min).toISOString(),
      outcome: 'delivered',
    });

  it('does nothing for a dot with no cron history', () => {
    expect(evaluateDotCronCatchUp(CHARTER, ctx(at(200)))).toEqual([]);
  });

  it('coalesces missed runs into one key at the latest missed minute', () => {
    delivered(0); // 10:00 delivered; daemon down until 13:30
    const [due] = evaluateDotCronCatchUp(CHARTER, ctx(at(210)));
    expect(due.key).toBe('cron:0 * * * *@2026-10-05T13:00');
    expect(due.detail).toContain('catch-up: 3 missed runs');
    ledger({ trigger_key: due.key, fired_at: at(211).toISOString(), outcome: 'delivered' });
    expect(evaluateDotCronCatchUp(CHARTER, ctx(at(212)))).toEqual([]);
  });

  it('is bounded by cron_catch_up_hours and skips when the current minute fires normally', () => {
    delivered(0);
    const short = {
      ...CHARTER,
      runtime: { heartbeat_id: 'x', cron_catch_up_hours: 1 },
    } as DotCharter;
    const [due] = evaluateDotCronCatchUp(short, ctx(at(24 * 60 + 30)));
    expect(due.detail).toContain('1 missed run');
    const off = {
      ...CHARTER,
      runtime: { heartbeat_id: 'x', cron_catch_up_hours: 0 },
    } as unknown as DotCharter;
    expect(evaluateDotCronCatchUp(off, ctx(at(300)))).toEqual([]);
    expect(evaluateDotCronCatchUp(CHARTER, ctx(at(240)))).toEqual([]); // 14:00 fires normally
  });

  it('does not fire when nothing was missed', () => {
    delivered(0);
    expect(evaluateDotCronCatchUp(CHARTER, ctx(at(30)))).toEqual([]);
  });
});
