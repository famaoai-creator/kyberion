/**
 * Resident-dot supervisor steps — per-sweep work beyond trigger evaluation
 * (executor, KR measurement, memory distillation, autonomy, arbitration …).
 *
 * The supervisor daemon calls {@link runDotSupervisorExtensions} once per dot
 * sweep, after housekeeping. A capability registers by appending ONE entry to
 * {@link DOT_SUPERVISOR_STEPS}. Every step is isolated: a throwing step is
 * logged in diagnostic format and the rest still run.
 */

import type { DotCharter, LoadedDotCharter } from '@agent/core/dot/dot-charter';
import { withExecutionContext } from '@agent/core/authority';
import type { DueDotTrigger } from '@agent/core/dot/dot-runtime';
import type { TriggerReceipt } from '@agent/core/trigger-runner';
import { isDurableEventKey, reconcileEventRunnerTerminal } from '@agent/core/dot/dot-event-intake';
import { createLogger } from '@agent/core/logger';
import { distillDotMemory } from '@agent/core/dot/dot-memory';
import { measureActiveDotKeyResults, runAsDotCharter } from '@agent/core/dot/dot-key-results';
import { evaluateDueDotOutcomes, scheduleDotOutcomeChecks } from '@agent/core/dot/dot-outcomes';
import { settleDotArbitration } from '@agent/core/dot/dot-arbitration';
import { runDotAutonomyStep } from '@agent/core/dot/dot-autonomy';
import { readDotActionLedger } from '@agent/core/dot/dot-action-ledger';
import { sendOpsAlert } from '@agent/core/ops-alert';
import { reportDotStepFailure, DotSupervisorStepCircuit } from '@agent/core/dot/dot-step-circuit';
import '@agent/core/dot/dot-extension-bootstrap';
import { FRONT_DESK_EXECUTION_SUPERVISOR_STEP } from '../front_desk_execution_step.js';
import { DOT_EXECUTOR_SUPERVISOR_STEP } from './dot_executor_step.js';
import { DOT_CONTINUOUS_OPERATIONS_SUPERVISOR_STEP } from './dot_continuous_operations_step.js';
import { DOT_ORG_CADENCE_SUPERVISOR_STEP } from './dot_org_cadence_step.js';
import { sweepOrganizationCadenceEnrollment } from '../organization/organization_cadence_reconcile.js';

const logger = createLogger('dot-supervisor');

export interface DotSupervisorStep {
  id: string;
  run(now: Date, active: LoadedDotCharter[]): Promise<void>;
}

export const DOT_SUPERVISOR_STEPS: DotSupervisorStep[] = [];

/** Run every registered step in order; returns the ids of steps that failed. */
export async function runDotSupervisorExtensions(
  now: Date,
  active: LoadedDotCharter[],
  steps: readonly DotSupervisorStep[] = DOT_SUPERVISOR_STEPS
): Promise<string[]> {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step.run(now, active);
    } catch (error) {
      failed.push(step.id);
      logger.warn(
        `supervisor step '${step.id}' failed — ${error instanceof Error ? error.message : String(error)} | next: the sweep continues; the step retries next sweep | evidence: scripts/dot/dot_supervisor_extensions.ts`
      );
    }
  }
  return failed;
}

// DL-03 key-result measurement (dots' KRs + referenced organization objectives' KRs),
// each charter measured inside its own role / tenant / organization context
DOT_SUPERVISOR_STEPS.push({
  id: 'dot-kr-measure',
  async run(_now, active) {
    await measureActiveDotKeyResults(active.map((entry) => entry.charter));
  },
});

// DL-05 weekly working-memory distillation (once per ISO week per dot)
const memoryDistillCircuit = new DotSupervisorStepCircuit('dot-memory-distill');
DOT_SUPERVISOR_STEPS.push({
  id: 'dot-memory-distill',
  async run(now, active) {
    for (const loaded of active) {
      const dotId = loaded.charter.dot_id;
      if (!memoryDistillCircuit.admits(dotId)) continue;
      try {
        await runAsDotCharter(loaded.charter, () =>
          distillDotMemory(loaded.charter, { now: () => now })
        );
        memoryDistillCircuit.reportSuccess(dotId);
      } catch (error) {
        reportDotStepFailure(memoryDistillCircuit, dotId, loaded.charter, error, {
          what: `memory distill failed for ${dotId}`,
          next: 'retried next sweep',
          evidence: 'libs/core/dot/dot-memory.ts',
          log: (line) => logger.warn(line),
        });
      }
    }
  },
});

// DL-11 settle combined arbitration cards (after housekeeping settled the newcomer).
// Registered BEFORE the executor: a WorkItem the approved newcomer supersedes
// is blocked in the same sweep, before the executor could claim it.
const arbitrationSettleCircuit = new DotSupervisorStepCircuit('dot-arbitration-settle');
DOT_SUPERVISOR_STEPS.push({
  id: 'dot-arbitration-settle',
  async run(now, active) {
    for (const loaded of active) {
      const dotId = loaded.charter.dot_id;
      if (!arbitrationSettleCircuit.admits(dotId)) continue;
      try {
        await runAsDotCharter(loaded.charter, async () =>
          settleDotArbitration(loaded.charter, now)
        );
        arbitrationSettleCircuit.reportSuccess(dotId);
      } catch (error) {
        reportDotStepFailure(arbitrationSettleCircuit, dotId, loaded.charter, error, {
          what: `arbitration settlement failed for ${dotId}`,
          next: 'retried next sweep',
          evidence: 'libs/core/dot/dot-arbitration.ts',
          log: (line) => logger.warn(line),
        });
      }
    }
  },
});

// DL-01 executor: closes at most one delegated WorkItem per dot per sweep
DOT_SUPERVISOR_STEPS.push(FRONT_DESK_EXECUTION_SUPERVISOR_STEP);
DOT_SUPERVISOR_STEPS.push(DOT_CONTINUOUS_OPERATIONS_SUPERVISOR_STEP);
DOT_SUPERVISOR_STEPS.push(DOT_EXECUTOR_SUPERVISOR_STEP);

// DL-04 outcome checks: schedule new done results, evaluate the due ones (each dot isolated)
const outcomesCircuit = new DotSupervisorStepCircuit('dot-outcomes');
DOT_SUPERVISOR_STEPS.push({
  id: 'dot-outcomes',
  async run(now, active) {
    for (const loaded of active) {
      const dotId = loaded.charter.dot_id;
      if (!outcomesCircuit.admits(dotId)) continue;
      try {
        await runAsDotCharter(loaded.charter, async () => {
          scheduleDotOutcomeChecks(loaded.charter, { now: () => now });
          await evaluateDueDotOutcomes(loaded.charter, { now: () => now });
        });
        outcomesCircuit.reportSuccess(dotId);
      } catch (error) {
        reportDotStepFailure(outcomesCircuit, dotId, loaded.charter, error, {
          what: `outcome check failed for ${dotId}`,
          next: 'retried next sweep',
          evidence: 'libs/core/dot/dot-outcomes.ts',
          log: (line) => logger.warn(line),
        });
      }
    }
  },
});

// DL-10 graduated autonomy: shadow ledger, automatic demotion, promotion cards
// (daily evaluation; a promotion applies only after a human approval settles)
const autonomyCircuit = new DotSupervisorStepCircuit('dot-autonomy');
DOT_SUPERVISOR_STEPS.push({
  id: 'dot-autonomy',
  async run(now, active) {
    for (const loaded of active) {
      const dotId = loaded.charter.dot_id;
      if (!autonomyCircuit.admits(dotId)) continue;
      try {
        await runAsDotCharter(loaded.charter, async () =>
          runDotAutonomyStep(loaded.charter, { now: () => now })
        );
        autonomyCircuit.reportSuccess(dotId);
      } catch (error) {
        reportDotStepFailure(autonomyCircuit, dotId, loaded.charter, error, {
          what: `autonomy step failed for ${dotId}`,
          next: 'retried next sweep; the level is unchanged',
          evidence: 'libs/core/dot/dot-autonomy.ts',
          log: (line) => logger.warn(line),
        });
      }
    }
  },
});

// Per-tenant organization cadences (operation tick, standup, retro) for charters
// that opt in with operations_cadence — scoped to the charter's own organization
// and run as its authority role, so no sovereign chronos daemon is required
DOT_SUPERVISOR_STEPS.push({
  id: 'organization-cadence-enrollment',
  async run(now) {
    sweepOrganizationCadenceEnrollment(now);
  },
});
DOT_SUPERVISOR_STEPS.push(DOT_ORG_CADENCE_SUPERVISOR_STEP);

/**
 * Loop-effectiveness watch: a dot whose trailing action window is all
 * declines/refusals/shadows — with nothing ever dispatched — is burning wakes
 * and tokens for zero effect (the repo-guardian pattern: 115 wakes, ~5M
 * tokens, 0 executed actions). One deduped alert per streak, cleared when the
 * dot produces an effect again.
 */
const EFFECTIVENESS_WINDOW = 20;
const EFFECTIVENESS_MIN_ROWS = 10;
const zeroEffectAlerted = new Set<string>();
// A broken ledger would otherwise warn once per dot per sweep forever — the
// same storm this step exists to prevent.
const effectivenessCircuit = new DotSupervisorStepCircuit('dot-effectiveness');
DOT_SUPERVISOR_STEPS.push({
  id: 'dot-effectiveness',
  async run(_now, active) {
    for (const loaded of active) {
      const dotId = loaded.charter.dot_id;
      if (!effectivenessCircuit.admits(dotId)) continue;
      try {
        const rows = readDotActionLedger({ dotId, indexOnly: true });
        const window = rows.slice(-EFFECTIVENESS_WINDOW);
        if (window.length < EFFECTIVENESS_MIN_ROWS) {
          zeroEffectAlerted.delete(dotId);
          effectivenessCircuit.reportSuccess(dotId);
          continue;
        }
        let dispatched = 0;
        let dead = 0;
        for (const row of window) {
          if (row.status === 'dispatched') dispatched++;
          // 'parked' counts as non-effect too: a vetoed proposal awaiting an
          // operator who never acts produces zero effect exactly like a
          // declined one (the real repo-guardian window is parked-dominant).
          // 'admitted'/'waiting_capacity' stay out — those can still dispatch.
          else if (
            row.status === 'declined' ||
            row.status === 'refused' ||
            row.status === 'shadow' ||
            row.status === 'parked'
          )
            dead++;
        }
        const zeroEffect = dispatched === 0 && dead * 2 >= window.length;
        if (!zeroEffect) {
          zeroEffectAlerted.delete(dotId);
          effectivenessCircuit.reportSuccess(dotId);
          continue;
        }
        if (zeroEffectAlerted.has(dotId)) {
          effectivenessCircuit.reportSuccess(dotId);
          continue;
        }
        sendOpsAlert({
          severity: 'warning',
          title: `Zero-effect loop detected: ${dotId}`,
          context: {
            dot_id: dotId,
            window: window.length,
            dispatched,
            non_effect: dead,
          },
          recommendation: `${dotId} keeps proposing work that never executes (${dispatched} dispatched of ${window.length} recent actions). Check its notify lane and approval routing — proposals that never reach a decider expire as 'declined' — and whether its observation inputs carry real data.`,
          dedupe_key: `dot-zero-effect:${dotId}`,
          category: 'dot',
        });
        // Mark alerted only after the alert actually landed — a failed send
        // must not permanently suppress the signal for this streak.
        zeroEffectAlerted.add(dotId);
        effectivenessCircuit.reportSuccess(dotId);
      } catch (error) {
        reportDotStepFailure(effectivenessCircuit, dotId, loaded.charter, error, {
          what: `effectiveness check failed for ${dotId}`,
          next: 'retried next sweep',
          evidence: 'libs/core/dot/dot-action-ledger.ts',
          log: (line) => logger.warn(line),
        });
      }
    }
  },
});

/** Duplicate is not an acknowledgement: require an exact authoritative terminal record. */
export function reconcileDotEventRunnerDuplicate(
  charter: DotCharter,
  key: string,
  receipt: TriggerReceipt,
  records: () => readonly TriggerReceipt[]
): void {
  if (receipt.status !== 'duplicate' || !isDurableEventKey(key)) return;
  const terminal = records().find(
    (r) =>
      r.idempotencyKey === receipt.idempotencyKey &&
      (r.status === 'delivered' || r.status === 'rejected')
  );
  if (terminal)
    withExecutionContext(
      charter.authority.authority_role,
      () => reconcileEventRunnerTerminal(charter, key, terminal),
      undefined,
      charter.scope.tenant_slug,
      charter.scope.organization_id
    );
}

export function triggerRunnerSource(trigger: DueDotTrigger): 'cron' | 'watch' | 'wake' {
  // probe / event / followup are dot-level kinds; at the runner they are a
  // wake (an observation or self-scheduled event), same as an inbox row.
  const kind = trigger.trigger.kind;
  return kind === 'cron' || kind === 'watch' ? kind : 'wake';
}
