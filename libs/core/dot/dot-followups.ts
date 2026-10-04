/**
 * DL-09 — self-scheduled follow-ups and cron catch-up.
 *
 * `dot_schedule_followup` lets a dot ask to be woken again later; the row lives
 * in a `dotStatePath`-scoped `followups.jsonl` (the reason is tenant prose) and
 * becomes a `followup:<id>` trigger once due. `evaluateDotCronCatchUp`
 * coalesces cron minutes missed during an outage (daemon down, budget pause)
 * into ONE wake whose key shares the normal `cron:<expr>@<minute>` key space,
 * so a delivered key never re-fires.
 *
 * Layering: this module is registered in the extension registry that
 * dot-runtime imports, so it must NOT import dot-runtime at runtime (a cycle
 * would hit the registry before this module initializes). Ledger reads are
 * therefore local; dot-followups.test.ts pins them to the dot-runtime contract.
 */

import * as path from 'node:path';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';
import { getZonedDateParts, matchesCron } from '../pipeline/cron-utils.js';
import { safeMkdir, safeWriteFile } from '../secure-io.js';
import type { DotCharter } from './dot-charter.js';
import type { DotExtCtx, DotPromptSection, DotWakeTool } from './dot-extensions.js';
import type { DotWakeLedgerEntry, DueDotTrigger } from './dot-runtime.js';
import { DOT_FOLLOWUPS_FILE, dotStatePath, type DotFollowupRow } from './dot-state-paths.js';

export const DOT_FOLLOWUP_MIN_DELAY_MINUTES = 5;
export const DOT_FOLLOWUP_MAX_DELAY_MINUTES = 7 * 24 * 60;
export const DOT_FOLLOWUP_DEFAULT_MAX_PENDING = 3;
export const DOT_FOLLOWUPS_PER_WAKE = 2;
export const DOT_FOLLOWUP_REASON_MAX = 300;
export const DOT_CRON_CATCH_UP_DEFAULT_HOURS = 6;
export const DOT_CRON_CATCH_UP_MAX_HOURS = 24;

/** Mirror of dot-runtime's wake-ledger path (see module note; pinned by test). */
export const DOT_FOLLOWUP_WAKE_LEDGER_PATH = 'active/shared/runtime/dot-wake-ledger.jsonl';
/** Mirror of dot-runtime's failed-key backoff (5 min doubling, capped at 6 h). */
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

export interface DotFollowupDeps {
  rootDir?: string;
  now?: () => Date;
}

const root = (deps: { rootDir?: string }): string => deps.rootDir ?? pathResolver.rootDir();

function readLedger(c: DotCharter, deps: DotFollowupDeps): DotWakeLedgerEntry[] {
  return readJsonLines<DotWakeLedgerEntry>(path.join(root(deps), DOT_FOLLOWUP_WAKE_LEDGER_PATH), {
    onMalformed: 'skip',
  }).filter((r) => r?.dot_id === c.dot_id && typeof r.trigger_key === 'string');
}

/** Same due-ness rule as dot-runtime's `buildDotDueChecker`, over pre-read rows. */
function dueChecker(rows: DotWakeLedgerEntry[], now: Date): (key: string) => boolean {
  const consumed = new Set<string>();
  const failures = new Map<string, { count: number; lastAt: number }>();
  for (const row of rows) {
    if (row.outcome === 'delivered' || row.outcome === 'rejected') {
      consumed.add(row.trigger_key);
      failures.delete(row.trigger_key);
    } else if (row.outcome === 'failed') {
      const at = Date.parse(row.fired_at);
      const prior = failures.get(row.trigger_key);
      failures.set(row.trigger_key, {
        count: (prior?.count ?? 0) + 1,
        lastAt: Math.max(prior?.lastAt ?? 0, Number.isFinite(at) ? at : 0),
      });
    }
  }
  return (key) => {
    if (consumed.has(key)) return false;
    const failed = failures.get(key);
    if (!failed) return true;
    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failed.count - 1));
    return now.getTime() - failed.lastAt >= wait;
  };
}

const followupKey = (id: string): string => `followup:${id}`;

function followupsFile(c: DotCharter, deps: { rootDir?: string }): string {
  return path.join(root(deps), dotStatePath(c, DOT_FOLLOWUPS_FILE));
}

function readFollowups(c: DotCharter, deps: { rootDir?: string }): DotFollowupRow[] {
  return readJsonLines<DotFollowupRow>(followupsFile(c, deps), { onMalformed: 'skip' }).filter(
    (r) =>
      r?.dot_id === c.dot_id && typeof r.followup_id === 'string' && typeof r.due_at === 'string'
  );
}

/** Follow-ups whose wake has not been delivered yet. */
export function listPendingDotFollowups(
  c: DotCharter,
  deps: DotFollowupDeps = {}
): DotFollowupRow[] {
  const consumed = new Set(
    readLedger(c, deps)
      .filter((r) => r.outcome === 'delivered' || r.outcome === 'rejected')
      .map((r) => r.trigger_key)
  );
  return readFollowups(c, deps).filter((r) => !consumed.has(followupKey(r.followup_id)));
}

export interface DotFollowupInput {
  delay_minutes: number;
  reason: string;
}

export function parseDotFollowup(
  input: unknown
): { ok: true; value: DotFollowupInput } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'follow-up must be an object' };
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.delay_minutes !== 'number' || !Number.isFinite(raw.delay_minutes)) {
    return { ok: false, error: 'delay_minutes must be a number' };
  }
  const reason = typeof raw.reason === 'string' ? raw.reason.replace(/\s+/g, ' ').trim() : '';
  if (!reason) return { ok: false, error: 'reason is required' };
  return {
    ok: true,
    value: {
      delay_minutes: Math.min(
        DOT_FOLLOWUP_MAX_DELAY_MINUTES,
        Math.max(DOT_FOLLOWUP_MIN_DELAY_MINUTES, raw.delay_minutes)
      ),
      reason: reason.slice(0, DOT_FOLLOWUP_REASON_MAX),
    },
  };
}

export const dotScheduleFollowupTool: DotWakeTool = {
  name: 'dot_schedule_followup',
  fence: 'dot-followup',
  maxPerWake: DOT_FOLLOWUPS_PER_WAKE,
  definition: {
    name: 'dot_schedule_followup',
    description:
      'Ask to be woken again later to re-check something (5 minutes to 7 days). Few pending follow-ups are allowed; state the reason so the next wake knows what to verify.',
    inputSchema: {
      type: 'object',
      properties: {
        delay_minutes: { type: 'number', description: 'Minutes from now (clamped 5..10080).' },
        reason: {
          type: 'string',
          description: `What to re-check (up to ${DOT_FOLLOWUP_REASON_MAX} characters).`,
        },
      },
      required: ['delay_minutes', 'reason'],
    },
  },
  parse: (input) => parseDotFollowup(input),
  apply(c, values, ctx) {
    const errors: string[] = [];
    const now = ctx.now();
    const deps = { rootDir: ctx.rootDir, now: ctx.now };
    const pending = listPendingDotFollowups(c, deps);
    const capacity =
      (c.followups?.max_pending ?? DOT_FOLLOWUP_DEFAULT_MAX_PENDING) - pending.length;
    const accepted = (values as DotFollowupInput[]).slice(0, Math.max(0, capacity));
    if (accepted.length < values.length) {
      errors.push(
        `dropped ${values.length - accepted.length} follow-up(s) (${pending.length} pending, max ${c.followups?.max_pending ?? DOT_FOLLOWUP_DEFAULT_MAX_PENDING})`
      );
    }
    if (accepted.length === 0) return errors;
    const file = followupsFile(c, deps);
    safeMkdir(path.dirname(file), { recursive: true });
    // Compact: keep only pending rows, then append the new ones.
    const keep = new Set(pending.map((r) => r.followup_id));
    const kept = readFollowups(c, deps).filter((r) => keep.has(r.followup_id));
    safeWriteFile(file, kept.map((r) => `${JSON.stringify(r)}\n`).join(''));
    accepted.forEach((value, index) => {
      appendJsonLine(file, {
        followup_id: `fu-${now.getTime().toString(36)}-${index}`,
        dot_id: c.dot_id,
        due_at: new Date(now.getTime() + value.delay_minutes * 60_000).toISOString(),
        reason: value.reason,
        created_at: now.toISOString(),
      } satisfies DotFollowupRow);
    });
    return errors;
  },
};

export const dotFollowupsPromptSection: DotPromptSection = {
  id: 'dot-followups',
  order: 60,
  lines(c, ctx: DotExtCtx) {
    const pending = listPendingDotFollowups(c, ctx);
    if (pending.length === 0) return [];
    return [
      'Your pending self-scheduled follow-ups (dot_schedule_followup):',
      ...pending.map((r) => `- ${r.due_at}: ${r.reason}`),
    ];
  },
};

/** Due follow-ups as `followup:<id>` triggers; consumed once a delivered wake row exists. */
export function evaluateDotFollowupsDue(
  c: DotCharter,
  deps: DotFollowupDeps = {}
): DueDotTrigger[] {
  const now = deps.now?.() ?? new Date();
  const rows = readFollowups(c, deps);
  if (rows.length === 0) return [];
  const isDue = dueChecker(readLedger(c, deps), now);
  return rows
    .filter((r) => Date.parse(r.due_at) <= now.getTime() && isDue(followupKey(r.followup_id)))
    .sort((a, b) => a.due_at.localeCompare(b.due_at))
    .map((r) => ({
      trigger: { kind: 'followup' as const },
      key: followupKey(r.followup_id),
      detail: `follow-up scheduled ${r.created_at}: ${r.reason}`,
    }));
}

/** Mirror of dot-runtime's cron minute key (pinned by test). */
export function dotCronMinuteKey(date: Date, timezone?: string): string {
  const p = getZonedDateParts(date, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * Cron minutes missed since the last delivered cron wake (bounded to
 * `runtime.cron_catch_up_hours`, default 6, max 24) coalesce into one wake per
 * expression, keyed by the latest missed minute. Never fires for a dot with no
 * cron history, nor when the current minute fires normally.
 */
export function evaluateDotCronCatchUp(c: DotCharter, deps: DotFollowupDeps = {}): DueDotTrigger[] {
  const now = deps.now?.() ?? new Date();
  const hours = Math.min(
    DOT_CRON_CATCH_UP_MAX_HOURS,
    Math.max(0, c.runtime.cron_catch_up_hours ?? DOT_CRON_CATCH_UP_DEFAULT_HOURS)
  );
  const triggers = c.attention.triggers.filter(
    (t): t is Extract<typeof t, { kind: 'cron' }> => t.kind === 'cron'
  );
  if (hours <= 0 || triggers.length === 0) return [];
  const rows = readLedger(c, deps);
  const isDue = dueChecker(rows, now);
  const floorMs = now.getTime() - hours * 3_600_000;
  const lastMinute = new Date(now.getTime());
  lastMinute.setSeconds(0, 0);
  const due: DueDotTrigger[] = [];
  for (const trigger of triggers) {
    if (matchesCron(trigger.cron, now, trigger.timezone)) continue;
    const prefix = `cron:${trigger.cron}@`;
    const own = rows.filter((r) => r.trigger_key.startsWith(prefix));
    if (own.length === 0) continue;
    const lastDelivered = own
      .filter((r) => r.outcome === 'delivered' || r.outcome === 'rejected')
      .reduce((max, r) => Math.max(max, Date.parse(r.fired_at) || 0), 0);
    const startMs = Math.max(lastDelivered, floorMs);
    const cursor = new Date(lastMinute.getTime() - 60_000);
    let missed = 0;
    let latest: Date | undefined;
    for (
      let step = 0;
      step < DOT_CRON_CATCH_UP_MAX_HOURS * 60 && cursor.getTime() > startMs;
      step++
    ) {
      if (matchesCron(trigger.cron, cursor, trigger.timezone)) {
        missed += 1;
        latest ??= new Date(cursor.getTime());
      }
      cursor.setTime(cursor.getTime() - 60_000);
    }
    if (!latest) continue;
    const key = `${prefix}${dotCronMinuteKey(latest, trigger.timezone)}`;
    if (!isDue(key)) continue;
    due.push({
      trigger,
      key,
      detail: `catch-up: ${missed} missed run${missed === 1 ? '' : 's'} of cron ${trigger.cron} since ${new Date(startMs).toISOString()}`,
    });
  }
  return due;
}
