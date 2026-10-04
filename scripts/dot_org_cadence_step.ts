/**
 * Per-tenant organization cadences in the resident-dot sweep (`dot-org-cadence`).
 *
 * A charter that opts in with `operations_cadence` gets its own organization's
 * operation tick, standup and retro run by the supervisor — inside
 * `runAsDotCharter` (the charter's authority role, tenant and organization),
 * using the scoped cadence mode, so no chronos daemon has to run as
 * KYBERION_PERSONA=sovereign. The repo cadence pipelines
 * (pipelines/organization-{operation-tick,standup,retro}.json) stay the
 * sovereign-only cross-tenant path.
 *
 * Scheduling state lives in `dotStatePath(charter, 'org-cadence.json')`:
 *   - tick: due every `tick_every_minutes` (default 15) after the last run;
 *   - standup / retro: once per cron occurrence. Only the LATEST occurrence in
 *     the look-back window is ever run, so downtime yields at most one
 *     catch-up run per cadence, never a storm.
 * The marker is written before the cadence runs (a crashed run is not retried
 * in a loop; the tick's occurrence-derived run IDs keep re-runs idempotent).
 * A charter whose organization budget is at the hard limit is skipped. The
 * step never throws: every charter and cadence is isolated and logged.
 */

import * as path from 'node:path';
import type { DotCharter, DotCadenceCron, LoadedDotCharter } from '@agent/core/dot/dot-charter';
import { runAsDotCharter } from '@agent/core/dot/dot-key-results';
import { dotBudgetHardThrottled } from '@agent/core/dot/dot-budget';
import { dotStatePath } from '@agent/core/dot/dot-state-paths';
import { readJsonIfPresent, writeJson } from '@agent/core/foundation/json';
import { createLogger } from '@agent/core/logger';
import {
  runOrganizationOperationTick,
  type OrganizationCadenceScope,
  type OrganizationOperationTickRunOptions,
} from '@agent/core/organization/organization-cadence';
import type { TickReport } from '@agent/core/organization/organization-operation-tick';
import {
  runOrganizationStandup,
  type OrganizationStandupRun,
  type RunOrganizationStandupOptions,
} from '@agent/core/organization/organization-standup';
import {
  runOrganizationRetro,
  type OrganizationRetroRun,
  type RunOrganizationRetroOptions,
} from '@agent/core/organization/organization-retro';
import { matchesCron } from '@agent/core/pipeline/cron-utils';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir } from '@agent/core/secure-io';
import type { DotSupervisorStep } from './dot_supervisor_extensions.js';

const logger = createLogger('dot-org-cadence');

export const DOT_ORG_CADENCE_STATE_FILE = 'org-cadence.json';
export const DOT_ORG_CADENCE_DEFAULT_TICK_MINUTES = 15;
export const DOT_ORG_CADENCE_MIN_TICK_MINUTES = 5;
/** How far back a missed standup / retro occurrence is still caught up (once). */
export const DOT_ORG_CADENCE_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

export type DotOrgCadenceKind = 'standup' | 'retro';

export interface DotOrgCadenceState {
  dot_id: string;
  tick?: { last_run_at: string };
  standup?: { last_occurrence: string; last_run_at: string };
  retro?: { last_occurrence: string; last_run_at: string };
}

/** Per-process scan memo so a sweep only re-scans the minutes since the previous sweep. */
export type CronScanMemo = Map<string, { scannedUntilMs: number; latestMs?: number }>;

export interface DotOrgCadenceDeps {
  rootDir?: string;
  runAs?: <T>(c: DotCharter, fn: () => Promise<T>) => Promise<T>;
  budgetHard?: (c: DotCharter) => boolean;
  tick?: (options: OrganizationOperationTickRunOptions) => Promise<TickReport>;
  standup?: (
    options: RunOrganizationStandupOptions,
    active: LoadedDotCharter[]
  ) => OrganizationStandupRun;
  retro?: (
    options: RunOrganizationRetroOptions,
    active: LoadedDotCharter[]
  ) => OrganizationRetroRun;
  memo?: CronScanMemo;
}

const processMemo: CronScanMemo = new Map();

function floorMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * The latest minute matching `cron` in (now - lookback, now], or undefined.
 * With a memo entry the scan covers only the minutes since the previous call.
 */
export function latestCronOccurrence(
  cron: string,
  timezone: string | undefined,
  now: Date,
  memo?: CronScanMemo,
  memoKey = `${cron}@${timezone ?? ''}`
): Date | undefined {
  const end = floorMinute(now.getTime());
  const windowStart = end - DOT_ORG_CADENCE_LOOKBACK_MS;
  const prior = memo?.get(memoKey);
  const resume = prior && prior.scannedUntilMs <= end && prior.scannedUntilMs > windowStart;
  const floor = resume ? prior.scannedUntilMs : windowStart;
  let latest = resume ? prior.latestMs : undefined;
  for (let cursor = end; cursor > floor; cursor -= MINUTE_MS) {
    if (matchesCron(cron, new Date(cursor), timezone)) {
      latest = cursor;
      break;
    }
  }
  memo?.set(memoKey, {
    scannedUntilMs: end,
    ...(latest !== undefined ? { latestMs: latest } : {}),
  });
  return latest !== undefined && latest > windowStart ? new Date(latest) : undefined;
}

export function dotOrgCadenceScope(c: DotCharter): OrganizationCadenceScope | undefined {
  const organizationId = c.scope.organization_id?.trim();
  if (!organizationId) return undefined;
  return {
    tier: c.scope.tier,
    organizationId,
    ...(c.scope.tenant_slug ? { tenantSlug: c.scope.tenant_slug } : {}),
  };
}

function statePath(c: DotCharter, rootDir?: string): string {
  return path.join(rootDir ?? pathResolver.rootDir(), dotStatePath(c, DOT_ORG_CADENCE_STATE_FILE));
}

function readState(c: DotCharter, rootDir?: string): DotOrgCadenceState {
  try {
    const stored = readJsonIfPresent<DotOrgCadenceState>(statePath(c, rootDir));
    if (stored && typeof stored === 'object') return { ...stored, dot_id: c.dot_id };
  } catch (error) {
    logger.warn(
      `org cadence state unreadable for ${c.dot_id} — ${error instanceof Error ? error.message : String(error)} | next: cadences restart from an empty state | evidence: ${dotStatePath(c, DOT_ORG_CADENCE_STATE_FILE)}`
    );
  }
  return { dot_id: c.dot_id };
}

function writeState(c: DotCharter, state: DotOrgCadenceState, rootDir?: string): void {
  const file = statePath(c, rootDir);
  safeMkdir(path.dirname(file), { recursive: true });
  writeJson(file, state);
}

export function tickIntervalMs(c: DotCharter): number {
  const minutes = c.operations_cadence?.tick_every_minutes ?? DOT_ORG_CADENCE_DEFAULT_TICK_MINUTES;
  return Math.max(DOT_ORG_CADENCE_MIN_TICK_MINUTES, minutes) * MINUTE_MS;
}

async function defaultTick(options: OrganizationOperationTickRunOptions): Promise<TickReport> {
  const { executeScheduledOrganizationOperation } =
    await import('./organization_operation_execute.js');
  return runOrganizationOperationTick(options, {
    executeOperation: executeScheduledOrganizationOperation,
  });
}

function diag(what: string, error: unknown, next: string, evidence: string): string {
  return `${what} — ${error instanceof Error ? error.message : String(error)} | next: ${next} | evidence: ${evidence}`;
}

/** Due cron occurrence for one cadence, or undefined when it already ran for it. */
function dueOccurrence(
  c: DotCharter,
  kind: DotOrgCadenceKind,
  spec: DotCadenceCron | undefined,
  state: DotOrgCadenceState,
  now: Date,
  memo: CronScanMemo
): Date | undefined {
  if (!spec) return undefined;
  const occurrence = latestCronOccurrence(
    spec.cron,
    spec.timezone,
    now,
    memo,
    `${c.dot_id}:${kind}:${spec.cron}@${spec.timezone ?? ''}`
  );
  if (!occurrence) return undefined;
  const last = Date.parse(state[kind]?.last_occurrence ?? '');
  return Number.isFinite(last) && last >= occurrence.getTime() ? undefined : occurrence;
}

/** Run one charter's due cadences inside its execution context. */
export async function runDotOrgCadenceForCharter(
  c: DotCharter,
  now: Date,
  active: LoadedDotCharter[],
  deps: DotOrgCadenceDeps = {}
): Promise<string[]> {
  const cadence = c.operations_cadence;
  const scope = dotOrgCadenceScope(c);
  if (!cadence || !scope) return [];
  if ((deps.budgetHard ?? ((charter) => dotBudgetHardThrottled(charter, { now: () => now })))(c)) {
    logger.info(
      `org cadence skipped for ${c.dot_id} — organization budget at the hard limit | next: resumes once the budget recovers | evidence: dot-budget`
    );
    return [];
  }
  const memo = deps.memo ?? processMemo;
  const runAs = deps.runAs ?? runAsDotCharter;
  return runAs(c, async () => {
    const ran: string[] = [];
    const state = readState(c, deps.rootDir);
    const nowIso = now.toISOString();

    const lastTick = Date.parse(state.tick?.last_run_at ?? '');
    if (!Number.isFinite(lastTick) || now.getTime() - lastTick >= tickIntervalMs(c)) {
      state.tick = { last_run_at: nowIso };
      writeState(c, state, deps.rootDir);
      try {
        const report = await (deps.tick ?? defaultTick)({ scope, apply: true, now });
        ran.push('tick');
        if (report.failures.length > 0) {
          logger.warn(
            `org tick for ${c.dot_id} had ${report.failures.length} failed run(s) — ${report.failures.join('; ')} | next: the operations are retried at their next due occurrence | evidence: ${dotStatePath(c, DOT_ORG_CADENCE_STATE_FILE)}`
          );
        }
      } catch (error) {
        logger.warn(
          diag(
            `org tick failed for ${c.dot_id}`,
            error,
            `retried after ${tickIntervalMs(c) / MINUTE_MS} minutes`,
            'libs/core/organization/organization-cadence.ts'
          )
        );
      }
    }

    for (const kind of ['standup', 'retro'] as const) {
      const spec = cadence[kind];
      const occurrence = dueOccurrence(c, kind, spec, state, now, memo);
      if (!spec || !occurrence) continue;
      state[kind] = { last_occurrence: occurrence.toISOString(), last_run_at: nowIso };
      writeState(c, state, deps.rootDir);
      try {
        const options = {
          scope,
          persist: true,
          ...(spec.timezone ? { timezone: spec.timezone } : {}),
        };
        if (kind === 'standup') {
          (deps.standup ?? ((o, list) => runOrganizationStandup(o, { listCharters: () => list })))(
            options,
            active
          );
        } else {
          (deps.retro ?? ((o, list) => runOrganizationRetro(o, { listCharters: () => list })))(
            options,
            active
          );
        }
        ran.push(kind);
      } catch (error) {
        logger.warn(
          diag(
            `org ${kind} failed for ${c.dot_id}`,
            error,
            `runs at the next ${kind} occurrence`,
            `libs/core/organization/organization-${kind}.ts`
          )
        );
      }
    }
    return ran;
  });
}

/** Supervisor entry: every active charter with `operations_cadence`, isolated. */
export async function runDotOrgCadenceStep(
  now: Date,
  active: LoadedDotCharter[],
  deps: DotOrgCadenceDeps = {}
): Promise<void> {
  for (const loaded of active) {
    if (!loaded.charter.operations_cadence) continue;
    try {
      await runDotOrgCadenceForCharter(loaded.charter, now, active, deps);
    } catch (error) {
      logger.warn(
        diag(
          `org cadence failed for ${loaded.charter.dot_id}`,
          error,
          'retried next sweep',
          'scripts/dot_org_cadence_step.ts'
        )
      );
    }
  }
}

export const DOT_ORG_CADENCE_SUPERVISOR_STEP: DotSupervisorStep = {
  id: 'dot-org-cadence',
  run: (now, active) => runDotOrgCadenceStep(now, active),
};
