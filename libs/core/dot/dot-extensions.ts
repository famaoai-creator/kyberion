/**
 * Dot extension seam — the contracts later resident-dot capabilities plug
 * into without editing the runtime / dispatch cores.
 *
 * Each interface has one ordered registry array in `dot-extension-registry.ts`;
 * dot-runtime, dot-dispatch and the dot CLI iterate those arrays. Every hook
 * call is isolated: a throwing extension is logged (diagnostic format) and
 * skipped, never allowed to fail the wake, the gate, or the digest.
 */

import type { AutonomousOpsGateResult } from '../governance/autonomous-ops-gate.js';
import type { ToolDefinition } from '../reasoning/reasoning-backend-contracts.js';
import type { DotCharter } from './dot-charter.js';
import type { DotDecisionLevel, DotProposal } from './dot-proposals.js';

export interface DotExtCtx {
  rootDir?: string;
  now: () => Date;
  /** Follow-up being completed by this wake, available only while applying successful outputs. */
  completingFollowupKey?: string;
}

/** Extra system-prompt lines; sections render in ascending `order`. */
export interface DotPromptSection {
  id: string;
  order: number;
  lines(c: DotCharter, ctx: DotExtCtx): string[];
}

/** Raises the decision floor for one proposal (merged with `strictest`). */
export interface DotFloorContributor {
  id: string;
  floor(c: DotCharter, p: DotProposal, ctx: DotExtCtx): DotDecisionLevel | undefined;
}

/** Runs after charter bounds, before the gate: refuse, pass, or force an operator decision. */
export interface DotPreGateCheck {
  id: string;
  check(
    c: DotCharter,
    p: DotProposal,
    ctx: DotExtCtx
  ):
    | { ok: true }
    | { ok: false; reason: string }
    | {
        ok: 'escalate';
        reason: string;
        card_context: string;
        link?: { action_ref: string; dot_id: string };
      };
}

/**
 * Marker a relaxer sets to claim the single policy-listed exception to the
 * clamp: an L4 dot's notify → auto for an `autonomy.relaxable_actions` action.
 * dot-dispatch re-checks the policy side itself (see
 * `dotNotifyToAutoExceptionApplies`); the marker alone never lowers anything.
 */
export const DOT_L4_NOTIFY_TO_AUTO_EXCEPTION = 'l4_notify_to_auto' as const;

/**
 * May lower the LEARNED floor only. dot-dispatch clamps the result so it is
 * never below the policy gate's own decision or the charter default — except
 * the one {@link DOT_L4_NOTIFY_TO_AUTO_EXCEPTION}, which dispatch re-verifies.
 * Relaxers are consulted when a learned floor exists or the gate says notify.
 */
export interface DotDecisionRelaxer {
  id: string;
  relax(
    c: DotCharter,
    p: DotProposal,
    gate: AutonomousOpsGateResult,
    floor: DotDecisionLevel | undefined,
    ctx: DotExtCtx
  ):
    | {
        decision: DotDecisionLevel;
        reason: string;
        exception?: typeof DOT_L4_NOTIFY_TO_AUTO_EXCEPTION;
      }
    | undefined;
}

/**
 * Runs after the gate, before routing. Returning `shadow` records the proposal
 * only: an action-ledger row with status `shadow`, no decision card, no
 * notification, no WorkItem (L0 autonomy). The hook may write its own evidence
 * (e.g. the autonomy shadow ledger) for the `action_ref` it is given. A
 * throwing override is skipped, so the proposal is governed normally.
 */
export interface DotDispositionOverride {
  id: string;
  dispose(
    c: DotCharter,
    p: DotProposal,
    info: {
      action_ref: string;
      gate: AutonomousOpsGateResult;
      floor?: DotDecisionLevel;
    },
    ctx: DotExtCtx
  ): { disposition: 'shadow'; reason: string } | undefined;
}

/**
 * A wake-scoped tool. Offered as a real tool on tool-capable backends and as a
 * fenced JSON block (```<fence>) on delegated backends; values are collected
 * during the wake and applied once by `applyDotWakeOutputs`.
 */
export interface DotWakeTool {
  name: string;
  fence: string;
  definition: ToolDefinition;
  maxPerWake: number;
  /** Durable wake outputs must not consume their trigger if persistence fails. */
  failWakeOnApplyError?: boolean;
  parse(input: unknown): { ok: true; value: unknown } | { ok: false; error: string };
  /** Returns error strings (empty when everything applied). */
  apply(c: DotCharter, values: unknown[], ctx: DotExtCtx): string[];
}

/** One section of `dot status <id>` output. */
export interface DotStatusSection {
  id: string;
  collect(c: DotCharter, ctx: DotExtCtx): Record<string, unknown>;
}

/** Extra digest lines appended after the built-in digest body. */
export interface DotDigestSection {
  id: string;
  lines(c: DotCharter, since: Date | undefined, ctx: DotExtCtx): string[];
}
