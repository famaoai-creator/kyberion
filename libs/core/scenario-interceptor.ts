/**
 * ES-02: scenario side-effect interceptor.
 *
 * Installs, for one scenario run, every seam the runner needs and returns a
 * single disposer that restores the previous state:
 *  - an observe-only preflight listener (`scenario-capture`) that records
 *    each op reaching preflight, plus an outcome observer that marks the
 *    record `admitted` once the op-preflight waterfall's final decision
 *    (after every listener and guard, regardless of registration order) is
 *    `allow`; the observer cannot itself change the decision;
 *  - the `scenario-op-override` seam: ops with a fixture are served by it,
 *    and in the `simulated` profile every other leaf op fails closed with
 *    `[SCENARIO_UNSTUBBED_OP]` (real actuators are never imported);
 *  - the risky-approval override: in the `simulated` profile it answers with
 *    the seed/turn decision but grants only fixture-served ops; in other
 *    profiles it records the request and defers to the canonical handler;
 *  - the fixture reasoning backend (ES-04, optional);
 *  - write detection by before/after snapshots of the run root.
 *
 * FU-01: every seam above acts only inside this run's async scope
 * (`runInScope`, see scenario-run-scope.ts). Calls from anywhere else in the
 * process see the normal op resolution, the canonical approval handler and
 * the previously bound reasoning backend, and are not recorded as side
 * effects; in the simulated profile a dispatch with no scenario scope at all
 * is recorded as a `scope_lost` warning (it may be run work whose async
 * context was lost). A risky
 * approval is granted only to a request made while a fixture handler serves
 * that same op.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import {
  registerScenarioOpOverride,
  type ActuatorOperationHandler,
  type ScenarioOpOverrideRequest,
} from './actuator-op-registry.js';
import { redactSensitiveObject } from './network.js';
import {
  registerOpPreflightListener,
  opPreflightCallKey,
  registerOpPreflightOutcomeObserver,
} from './op-preflight.js';
import {
  overrideRiskyApprovalHandler,
  type RiskyApprovalResult,
} from './risky-op-approval-port.js';
import type {
  ScenarioApprovalDecision,
  ScenarioDefinition,
  ScenarioOpFixture,
} from './scenario-definition.js';
import { installScenarioFixtureBackend } from './scenario-model-fixtures.js';
import type { ScenarioRunContext } from './scenario-run-context.js';
import {
  getActiveScenarioRunId,
  getServingScenarioFixtureOp,
  runInScenarioScope,
  runServingScenarioFixture,
} from './scenario-run-scope.js';
import {
  appendScenarioApproval,
  appendScenarioOp,
  appendScenarioWarning,
  appendScenarioWrite,
  createScenarioSideEffectLog,
  type ScenarioOpRecord,
  type ScenarioSideEffectLog,
  type ScenarioWarningRecord,
} from './scenario-side-effect-log.js';
import { safeExistsSync, safeLstat, safeReadFile, safeReaddir } from './secure-io.js';

export type {
  ScenarioApprovalRecord,
  ScenarioOpRecord,
  ScenarioReasoningRecord,
  ScenarioSideEffectLog,
  ScenarioWarningRecord,
  ScenarioWriteRecord,
} from './scenario-side-effect-log.js';

export const SCENARIO_CAPTURE_LISTENER_ID = 'scenario-capture';

/**
 * Leaf ops that stay on their normal path in the simulated profile without a
 * fixture: pure in-process ops, composite ops whose nested leaf ops are
 * intercepted individually, plus reasoning leaves (served by the fixture
 * backend, which fails closed on its own).
 */
export const SCENARIO_SIMULATED_PASSTHROUGH_OPS: readonly string[] = [
  'system:log',
  'core:transform',
  'core:ptc',
  'core:programmatic_tool_call',
  'core:run_pipeline',
  'reasoning:analyze',
  'reasoning:transform',
  'reasoning:synthesize',
];

const APPROVAL_DECISIONS = new Set<ScenarioApprovalDecision>(['approved', 'rejected', 'pending']);

export interface ScenarioInterceptorOptions {
  /** Bind the ES-04 fixture reasoning backend (default true). */
  installReasoning?: boolean;
}

export interface ScenarioInterceptor {
  readonly log: ScenarioSideEffectLog;
  /** Async-scope id this interceptor's seams answer to (unique per install). */
  readonly scopeId: string;
  /** Run `fn` inside this run's scope; seams ignore calls made outside it. */
  runInScope<T>(fn: () => T): T;
  setApprovalDecision(op: string, decision: ScenarioApprovalDecision): void;
  getApprovalDecision(op: string): ScenarioApprovalDecision;
  /** Diff the run root against the previous snapshot and append write records. */
  snapshotWrites(): void;
  dispose(): void;
}

function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const visible = Object.fromEntries(
    Object.entries(params).filter(([key]) => !key.startsWith('_'))
  );
  return redactSensitiveObject(visible);
}

function seedApprovalDecisions(def: ScenarioDefinition): Map<string, ScenarioApprovalDecision> {
  const decisions = new Map<string, ScenarioApprovalDecision>();
  (def.seed.approvals ?? []).forEach((entry, index) => {
    const op = entry.op;
    const decision = entry.decision;
    if (
      typeof op !== 'string' ||
      !op.includes(':') ||
      typeof decision !== 'string' ||
      !APPROVAL_DECISIONS.has(decision as ScenarioApprovalDecision)
    ) {
      throw new Error(
        `[SCENARIO_INVALID_SEED_APPROVAL] seed.approvals[${index}] must be { op: "domain:action", decision: approved|rejected|pending }`
      );
    }
    decisions.set(op, decision as ScenarioApprovalDecision);
  });
  return decisions;
}

type RunRootSnapshot = Map<string, { sha256: string; bytes: number }>;

function snapshotRunRoot(runRoot: string): RunRootSnapshot {
  const snapshot: RunRootSnapshot = new Map();
  if (!safeExistsSync(runRoot)) return snapshot;
  const walk = (dir: string): void => {
    for (const entry of safeReaddir(dir).sort()) {
      const abs = path.join(dir, entry);
      const stat = safeLstat(abs);
      if (stat.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!stat.isFile()) continue;
      const content = safeReadFile(abs, { encoding: null }) as Buffer;
      const relative = path.relative(runRoot, abs).split(path.sep).join('/');
      snapshot.set(relative, {
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        bytes: content.length,
      });
    }
  };
  walk(runRoot);
  return snapshot;
}

/** Run every disposer (newest first) even if one throws; rethrow the first failure. */
function disposeInReverse(disposers: Array<() => void>): void {
  let failure: { error: unknown } | undefined;
  for (const dispose of disposers.splice(0).reverse()) {
    try {
      dispose();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

export function installScenarioInterceptor(
  ctx: ScenarioRunContext,
  def: ScenarioDefinition,
  options: ScenarioInterceptorOptions = {}
): ScenarioInterceptor {
  const log = createScenarioSideEffectLog();
  const decisions = seedApprovalDecisions(def);
  const passthrough = new Set(SCENARIO_SIMULATED_PASSTHROUGH_OPS);
  const disposers: Array<() => void> = [];
  const preflightRecords = new WeakMap<object, ScenarioOpRecord>();
  let baseline = snapshotRunRoot(ctx.runRoot);
  let disposed = false;
  const scopeId = `${ctx.runId}:${crypto.randomBytes(8).toString('hex')}`;
  const inScope = (): boolean => getActiveScenarioRunId() === scopeId;
  // FU-01: in the simulated profile, a dispatch with no scenario scope at all
  // may be run work that lost its async context (and so escaped the fixtures).
  // Unrelated host work is never blocked, but the leak is surfaced.
  const noteScopeLost = (op: string, source: ScenarioWarningRecord['source']): void => {
    if (def.executionProfile !== 'simulated' || getActiveScenarioRunId() !== undefined) return;
    appendScenarioWarning(log, { kind: 'scope_lost', op, source });
  };

  const decisionFor = (op: string): ScenarioApprovalDecision => decisions.get(op) ?? 'pending';
  const fixtureFor = (op: string): ScenarioOpFixture | undefined =>
    Object.hasOwn(def.fixtures.ops, op) ? def.fixtures.ops[op] : undefined;

  function fixtureHandler(op: string, fixture: ScenarioOpFixture): ActuatorOperationHandler {
    return (_action, params, context, stepType) =>
      runServingScenarioFixture(op, async () => {
        const record = { op, stage: 'apply' as const, params: sanitizeParams(params), stepType };
        if (fixture.error !== undefined) {
          appendScenarioOp(log, { ...record, outcome: 'error', error: fixture.error });
          throw new Error(fixture.error);
        }
        appendScenarioOp(log, { ...record, outcome: 'ok' });
        const exportKey = typeof params.export_as === 'string' ? params.export_as : undefined;
        return {
          handled: true,
          ctx: {
            ...context,
            ...(fixture.ctx_patch ?? {}),
            ...(exportKey && fixture.result !== undefined ? { [exportKey]: fixture.result } : {}),
          },
        };
      });
  }

  try {
    disposers.push(
      registerOpPreflightListener({
        id: SCENARIO_CAPTURE_LISTENER_ID,
        order: Number.MIN_SAFE_INTEGER,
        run: (call) => {
          if (!inScope()) {
            noteScopeLost(call.op, call.source);
            return undefined;
          }
          const record = appendScenarioOp(log, {
            op: call.op,
            stage: 'preflight',
            params: sanitizeParams(call.params),
            source: call.source,
            requiresApproval: call.requiresApproval === true,
            approvalGranted: call.approvalGranted === true,
          });
          preflightRecords.set(opPreflightCallKey(call), record);
          if (call.requiresApproval && !call.approvalGranted) {
            appendScenarioApproval(log, {
              op: call.op,
              kind: 'requested',
              channel: 'pipeline',
              decision: decisionFor(call.op),
            });
          }
          return undefined;
        },
      })
    );

    // The outcome observer fires once the op-preflight waterfall has a final
    // decision for the call, independent of guard/listener registration
    // order (see op-preflight.ts N6 fix); it only ever reads that decision.
    disposers.push(
      registerOpPreflightOutcomeObserver((call, result) => {
        if (!inScope()) return;
        const record = preflightRecords.get(opPreflightCallKey(call));
        if (record && result.decision === 'allow') record.admitted = true;
      })
    );

    disposers.push(
      registerScenarioOpOverride({
        resolve(request: ScenarioOpOverrideRequest) {
          if (!inScope()) {
            if (request.purpose === 'dispatch') noteScopeLost(request.op, 'op-dispatch');
            return undefined;
          }
          const fixture = fixtureFor(request.op);
          if (fixture) return { handler: fixtureHandler(request.op, fixture) };
          if (def.executionProfile !== 'simulated' || passthrough.has(request.op)) {
            return undefined;
          }
          if (request.purpose !== 'approval-probe') {
            appendScenarioOp(log, { op: request.op, stage: 'unstubbed' });
          }
          throw new Error(
            `[SCENARIO_UNSTUBBED_OP] ${request.op} has no fixture in scenario ${def.id} (simulated profile fails closed)`
          );
        },
        approvalGranted(request: ScenarioOpOverrideRequest) {
          if (!inScope()) return false;
          return fixtureFor(request.op) !== undefined && decisionFor(request.op) === 'approved';
        },
      })
    );

    disposers.push(
      overrideRiskyApprovalHandler((params): RiskyApprovalResult | undefined => {
        if (!inScope()) return undefined;
        const decision = decisionFor(params.opId);
        appendScenarioApproval(log, {
          op: params.opId,
          kind: 'requested',
          channel: 'risky-approval',
          decision,
        });
        // Outside the simulated profile real effects run, so only the
        // canonical (human) approval path may answer.
        if (def.executionProfile !== 'simulated') return undefined;
        if (decision === 'approved') {
          // Only a request raised while a fixture serves this very op may be
          // granted; anything else could be a real effect.
          if (fixtureFor(params.opId) && getServingScenarioFixtureOp() === params.opId) {
            return { allowed: true, status: 'approved' };
          }
          return {
            allowed: false,
            status: 'pending',
            message: `[SCENARIO_APPROVAL_UNFIXTURED] ${params.opId} was not requested by a fixture-served dispatch; a scenario approval cannot admit a real effect`,
          };
        }
        return {
          allowed: false,
          status: 'pending',
          message:
            decision === 'rejected'
              ? `[SCENARIO_APPROVAL_REJECTED] ${params.opId}`
              : `[SCENARIO_APPROVAL_PENDING] ${params.opId}`,
        };
      })
    );

    if (options.installReasoning !== false) {
      disposers.push(installScenarioFixtureBackend(def, log, { scopeId }));
    }
  } catch (error) {
    try {
      disposeInReverse(disposers);
    } catch {
      // the install failure is the error worth reporting
    }
    throw error;
  }

  return {
    log,
    scopeId,
    runInScope: (fn) => runInScenarioScope(scopeId, fn),
    setApprovalDecision(op, decision) {
      if (!APPROVAL_DECISIONS.has(decision)) {
        throw new Error(`[SCENARIO_INVALID_APPROVAL_DECISION] ${String(decision)}`);
      }
      const previous = decisionFor(op);
      decisions.set(op, decision);
      appendScenarioApproval(log, { op, kind: 'decided', channel: 'scenario', decision, previous });
    },
    getApprovalDecision: decisionFor,
    snapshotWrites() {
      const current = snapshotRunRoot(ctx.runRoot);
      const paths = [...new Set([...baseline.keys(), ...current.keys()])].sort();
      for (const relative of paths) {
        const before = baseline.get(relative);
        const after = current.get(relative);
        if (before && !after) {
          appendScenarioWrite(log, { path: relative, change: 'deleted' });
        } else if (after && (!before || before.sha256 !== after.sha256)) {
          appendScenarioWrite(log, {
            path: relative,
            change: before ? 'modified' : 'created',
            sha256: after.sha256,
            bytes: after.bytes,
          });
        }
      }
      baseline = current;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeInReverse(disposers);
    },
  };
}
