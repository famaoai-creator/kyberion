import { afterEach, describe, expect, it, vi } from 'vitest';

import { safeRmSync } from '../secure-io.js';
import { validateDotCharter, type DotCharter, type DotFeedTrigger } from './dot-charter.js';
import {
  evaluateDotEventTriggers,
  readDotInboundEvents,
  type EventIntakePolicy,
} from './dot-event-intake.js';
import {
  compareCursorRanks,
  cursorRank,
  evaluateDotFeedTriggers,
  feedSpecId,
  readDotFeedCoverage,
  readFeedState,
  resolveFeedSourceBinding,
  type DotFeedDeps,
} from './dot-feed-source.js';

const TEST_ROOT = 'active/shared/tmp/dot-feed-source-tests';

const POLICY: EventIntakePolicy = {
  version: '1.0.0',
  sources: {
    slack: {
      enabled: false,
      signature_header: 'x-kyberion-signature',
      prefix: 'sha256=',
      secret_key: 'EVENT_INTAKE_SLACK_SECRET',
      event_type_header: 'x-kyberion-event',
      delivery_id_header: 'x-kyberion-delivery',
      max_body_bytes: 65536,
    },
    acme: {
      enabled: false,
      signature_header: 'x-kyberion-signature',
      prefix: 'sha256=',
      secret_key: 'EVENT_INTAKE_ACME_SECRET',
      event_type_header: 'x-kyberion-event',
      delivery_id_header: 'x-kyberion-delivery',
      tenant_slug: 'acme',
      max_body_bytes: 65536,
    },
  },
};

const T0 = new Date('2026-10-25T00:00:00Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

function feed(overrides: Partial<DotFeedTrigger> = {}): DotFeedTrigger {
  return {
    kind: 'feed',
    source: 'slack',
    service_id: 'slack',
    action: 'search_messages',
    params: { query: 'deploy failed' },
    items_path: 'messages.matches',
    item_id_path: 'ts',
    cursor_path: 'ts',
    event_type: 'slack_message',
    every_s: 30,
    ...overrides,
  };
}

function charter(overrides: Partial<DotCharter> = {}): DotCharter {
  return {
    kind: 'dot-charter',
    dot_id: 'ops-watch',
    version: '1.0.0',
    title: 'Ops watch',
    purpose: 'Watch Slack for deployment failures.',
    status: 'active',
    scope: { tier: 'public' },
    goal: { statement: 'Surface deployment failures that need a human decision.' },
    attention: {
      triggers: [feed(), { kind: 'event', sources: ['slack'], types: ['slack_message'] }],
    },
    authority: { authority_role: 'operations_analyst' },
    notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
    runtime: { heartbeat_id: 'dot-ops-watch' },
    ...overrides,
  };
}

function slackPage(items: unknown[]): unknown {
  return { ok: true, messages: { matches: items } };
}

function message(ts: string, text = 'deploy failed'): Record<string, unknown> {
  return { ts, text, user: 'U123', channel: { name: 'ops' } };
}

function deps(items: unknown[], now: Date, extra: Partial<DotFeedDeps> = {}): DotFeedDeps {
  return {
    rootDir: TEST_ROOT,
    policy: POLICY,
    now: () => now,
    serviceCall: async () => slackPage(items),
    ...extra,
  };
}

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('feed cursor ranking', () => {
  it('ranks Slack ts, ISO timestamps and opaque strings', () => {
    expect(
      compareCursorRanks(cursorRank('1730000200.000200'), cursorRank('1730000100.000100'))
    ).toBeGreaterThan(0);
    expect(
      compareCursorRanks(cursorRank('2026-10-25T00:00:02Z'), cursorRank('2026-10-25T00:00:01Z'))
    ).toBeGreaterThan(0);
    expect(compareCursorRanks(cursorRank('b'), cursorRank('a'))).toBeGreaterThan(0);
    expect(cursorRank('')).toBeUndefined();
  });

  it('changes the spec id when the query changes', () => {
    expect(feedSpecId(feed())).not.toBe(feedSpecId(feed({ params: { query: 'other' } })));
    expect(feedSpecId(feed())).toBe(feedSpecId(feed()));
  });
});

describe('feed polling', () => {
  it('baselines the first poll, then ingests only new items once', async () => {
    const first = [message('1730000100.000100', 'first')];
    let polls = await evaluateDotFeedTriggers(charter(), deps(first, at(0)));
    expect(polls[0]).toMatchObject({ status: 'baseline', ingested: 0, observed: 1 });
    expect(readDotInboundEvents(undefined, { rootDir: TEST_ROOT })).toHaveLength(0);

    // Same page again: the seen ring suppresses a second event.
    polls = await evaluateDotFeedTriggers(charter(), deps(first, at(60)));
    expect(polls[0]).toMatchObject({ status: 'polled', ingested: 0, duplicate: 1 });

    const second = [...first, message('1730000200.000200', 'second')];
    polls = await evaluateDotFeedTriggers(charter(), deps(second, at(120)));
    expect(polls[0]).toMatchObject({ status: 'polled', ingested: 1, duplicate: 1 });

    const events = readDotInboundEvents(undefined, { rootDir: TEST_ROOT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: 'slack', type: 'slack_message' });
    expect(events[0].summary).toContain('second');

    // The ingested event wakes the dot through its ordinary event trigger.
    const due = evaluateDotEventTriggers(charter(), { rootDir: TEST_ROOT, now: () => at(130) });
    expect(due).toHaveLength(1);
    expect(due[0].key).toBe(`event:${events[0].event_id}`);

    const coverage = readDotFeedCoverage(charter(), { rootDir: TEST_ROOT }, at(130));
    expect(coverage[0]).toMatchObject({ state: 'healthy', ingested: 1 });
  });

  it('drops items behind the cursor unless they fall inside overlap', async () => {
    await evaluateDotFeedTriggers(charter(), deps([message('1730000100.000100')], at(0)));
    // 90s older than the watermark, outside the default overlap.
    await evaluateDotFeedTriggers(
      charter(),
      deps([message('1730000100.000100'), message('1730000010.000010')], at(60))
    );
    expect(readDotInboundEvents(undefined, { rootDir: TEST_ROOT })).toHaveLength(0);

    const overlapping = charter({
      attention: {
        triggers: [
          feed({ overlap_s: 120 }),
          { kind: 'event', sources: ['slack'], types: ['slack_message'] },
        ],
      },
    });
    const polls = await evaluateDotFeedTriggers(
      overlapping,
      deps([message('1730000100.000100'), message('1730000010.000010')], at(120))
    );
    expect(polls[0].ingested).toBe(1);
  });

  it('emits the backlog only when the operator asks for it', async () => {
    const backlog = [message('1730000100.000100'), message('1730000200.000200')];
    const emitOnFirst = charter({
      attention: {
        triggers: [
          feed({ on_first_poll: 'emit' }),
          { kind: 'event', sources: ['slack'], types: ['slack_message'] },
        ],
      },
    });
    const polls = await evaluateDotFeedTriggers(emitOnFirst, deps(backlog, at(0)));
    expect(polls[0]).toMatchObject({ status: 'polled', ingested: 2 });
    expect(readDotInboundEvents(undefined, { rootDir: TEST_ROOT })).toHaveLength(2);
  });

  it('keeps the newest window and reports the cap', async () => {
    const capped = charter({
      attention: {
        triggers: [
          feed({ on_first_poll: 'emit', max_items: 2 }),
          { kind: 'event', sources: ['slack'], types: ['slack_message'] },
        ],
      },
    });
    const polls = await evaluateDotFeedTriggers(
      capped,
      deps(
        [message('1730000100.000100'), message('1730000200.000200'), message('1730000300.000300')],
        at(0)
      )
    );
    expect(polls[0]).toMatchObject({ status: 'polled', ingested: 2, truncated: true });
    const coverage = readDotFeedCoverage(capped, { rootDir: TEST_ROOT }, at(10));
    expect(coverage[0].capped_polls).toBe(1);
  });

  it('skips a poll that is inside its cadence', async () => {
    await evaluateDotFeedTriggers(charter(), deps([message('1730000100.000100')], at(0)));
    const polls = await evaluateDotFeedTriggers(charter(), deps([], at(5)));
    expect(polls[0].status).toBe('skipped');
  });

  it('refuses a source bound to another tenant without writing events', async () => {
    const tenantCharter = charter({
      scope: { tier: 'confidential', tenant_slug: 'acme' },
      attention: {
        triggers: [feed({ source: 'slack' }), { kind: 'event', sources: ['slack'] }],
      },
    });
    const polls = await evaluateDotFeedTriggers(
      tenantCharter,
      deps([message('1730000100.000100')], at(0))
    );
    expect(polls[0].status).toBe('failed');
    expect(polls[0].error).toMatch(/bound to tenant/);
    expect(readDotInboundEvents('acme', { rootDir: TEST_ROOT })).toHaveLength(0);
    expect(resolveFeedSourceBinding(feed(), tenantCharter, POLICY)).toMatch(/bound to tenant/);
  });

  it('refuses an undeclared source', async () => {
    const unknown = charter({
      attention: {
        triggers: [feed({ source: 'nope' }), { kind: 'event', sources: ['nope'] }],
      },
    });
    const polls = await evaluateDotFeedTriggers(unknown, deps([], at(0)));
    expect(polls[0]).toMatchObject({ status: 'failed' });
    expect(polls[0].error).toMatch(/not declared/);
  });

  it('backs off, records the failure and reports stalled coverage', async () => {
    const failing = charter();
    const failingDeps = (now: Date) =>
      deps([], now, {
        serviceCall: async () => {
          throw new Error('slack_unavailable');
        },
      });
    await evaluateDotFeedTriggers(failing, failingDeps(at(0)));
    const afterOne = readDotFeedCoverage(failing, { rootDir: TEST_ROOT }, at(10));
    expect(afterOne[0].state).toBe('failing');
    expect(afterOne[0].last_error).toMatch(/slack_unavailable/);

    // Failure backoff doubles the interval: 30s → 60s.
    expect((await evaluateDotFeedTriggers(failing, failingDeps(at(40))))[0].status).toBe('skipped');
    await evaluateDotFeedTriggers(failing, failingDeps(at(70)));
    const afterTwo = readDotFeedCoverage(failing, { rootDir: TEST_ROOT }, at(80));
    expect(afterTwo[0]).toMatchObject({ state: 'stalled', consecutive_failures: 2 });
    expect(afterTwo[0].detail).toMatch(/blind/);
  });

  it('reports a wedged provider as a timeout, not a malformed result', async () => {
    vi.useFakeTimers();
    try {
      const hanging = charter();
      const pending = evaluateDotFeedTriggers(
        hanging,
        deps([], at(0), { serviceCall: () => new Promise<never>(() => {}) })
      );
      await vi.advanceTimersByTimeAsync(25_000);
      const polls = await pending;
      expect(polls[0]).toMatchObject({ status: 'failed' });
      expect(polls[0].error).toMatch(/timed out/);
      const coverage = readDotFeedCoverage(hanging, { rootDir: TEST_ROOT }, at(30));
      expect(coverage[0].last_error).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers and clears the failure streak on the next good poll', async () => {
    const recovering = charter();
    const boom = deps([], at(0), {
      serviceCall: async () => {
        throw new Error('transient');
      },
    });
    await evaluateDotFeedTriggers(recovering, boom);
    await evaluateDotFeedTriggers(recovering, deps([message('1730000100.000100')], at(70)));
    const state = readFeedState(recovering, feed(), { rootDir: TEST_ROOT });
    expect(state.consecutive_failures).toBe(0);
    expect(state.last_error).toBeUndefined();
    expect(state.cursor).toBe('1730000100.0001');
  });
});

describe('feed charter validation', () => {
  it('validates the declared feed shape', () => {
    const validated = validateDotCharter(charter());
    expect(validated.attention.triggers[0].kind).toBe('feed');
  });
});
