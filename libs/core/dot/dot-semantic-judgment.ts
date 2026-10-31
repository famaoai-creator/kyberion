/** Post-baseline observer contract with an offline fixture hook; no production wallet/provider or effects. */
import { z } from 'zod';
import { normalizeEventScope } from '../event-scope.js';
import { getUsageAttribution, withUsageAttribution } from '../usage-accounting.js';
import { judgmentBindingSchema, judgmentScopeSchema } from '../organization/judgment-contract.js';
import { judgmentCanonicalHash } from '../organization/judgment-precedents.js';
import {
  assessSemanticJudgment,
  type OfflineJudgmentInvokePort,
  type SemanticJudgmentDeps,
  type SemanticJudgmentUsage,
} from '../organization/semantic-judgment.js';
import type {
  JudgmentEvidenceDeps,
  JudgmentEvidenceReference,
  JudgmentEvidenceRequest,
  JudgmentEvidenceResult,
  saveJudgmentEvidence,
} from '../organization/judgment-evidence.js';
import type { ScopeContext } from '../scope-context-validation.js';
import type { DotProposal } from './dot-proposals.js';

export interface DotSemanticParent {
  dot_id: string;
  accounting_id: string;
  scope: ScopeContext;
  day: string;
  deadline_ms: number;
  /** Trusted baseline boundary, never a model claim; runtime wiring requires explicit offline fixture ports. */
  baseline_complete: true;
}
export interface DotSemanticBudgetOwner {
  dot_id: string;
  accounting_id: string;
  scope_hash: string;
  day: string;
}
export type DotSemanticKnownUsage = SemanticJudgmentUsage & {
  input_tokens: number;
  output_tokens: number;
  usage_status: 'reported' | 'not_invoked';
};
export interface DotSemanticSharedBudgetPort {
  /** Explicit test qualification only. A label is not proof of production budget enforcement. */
  mode: 'offline_fixture';
  reserve(input: {
    parent: DotSemanticBudgetOwner;
    reservation_key: string;
    max_tokens: number;
  }):
    | { status: 'reserved'; handle: object; owner: DotSemanticBudgetOwner; token_allowance: number }
    | { status: 'unavailable' };
  /** Opaque issuer-owned handle; unknown usage retains the original shared-parent reservation. */
  holdUnknown(handle: object, parent: DotSemanticBudgetOwner): { status: 'held_unknown' };
  /** Final known settlement is idempotent for the same usage, rejects changed/foreign handles. */
  settle(
    handle: object,
    parent: DotSemanticBudgetOwner,
    usage: DotSemanticKnownUsage
  ): { status: 'settled' };
}
export interface PreparedDotSemanticJudgment {
  request: JudgmentEvidenceRequest;
  requested_total_tokens: number;
  readCurrentContext: SemanticJudgmentDeps['readCurrentContext'];
  createTrace?: JudgmentEvidenceDeps['createTrace'];
}
export interface DotSemanticJudgmentInput {
  mode: 'off' | 'shadow';
  parent: DotSemanticParent;
  proposals: readonly DotProposal[];
  signal?: AbortSignal;
}
export interface DotSemanticJudgmentDeps {
  now?: () => number;
  schedule?: SemanticJudgmentDeps['schedule'];
  canEvaluate?: () => boolean;
  prepare?: (proposal: DotProposal, parent: DotSemanticParent) => PreparedDotSemanticJudgment;
  budget?: DotSemanticSharedBudgetPort;
  invoke?: OfflineJudgmentInvokePort;
  persist?: (
    input: Parameters<typeof saveJudgmentEvidence>[0],
    deps: JudgmentEvidenceDeps
  ) => JudgmentEvidenceResult;
}
export interface DotSemanticObservation {
  proposal_index: number;
  status: 'skipped' | 'observed' | 'unavailable' | 'pending_stop';
  reason: string;
  budget_status:
    'not_reserved' | 'settled' | 'held_unknown' | 'settlement_failed' | 'foreign_reservation';
  additional_model_calls: number | null;
  /** False on detachment: returning the baseline is not proof that a provider stopped. */
  stop_confirmed?: boolean;
  usage?: SemanticJudgmentUsage;
  receipt?: JudgmentEvidenceReference;
}

const key = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim());
const ownerSchema = z
  .object({
    dot_id: key,
    accounting_id: key,
    scope_hash: z.string().regex(/^[a-f0-9]{64}$/u),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  })
  .strict();
const parentSchema = z
  .object({
    dot_id: key,
    accounting_id: key,
    scope: judgmentScopeSchema,
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    deadline_ms: z.number().finite(),
    baseline_complete: z.literal(true),
  })
  .strict();
const tokenLimit = z.number().finite().int().min(1).max(1_000_000);
const noUsage = (): DotSemanticKnownUsage => ({
  calls: 0,
  input_tokens: 0,
  output_tokens: 0,
  elapsed_ms: 0,
  usage_status: 'not_invoked',
});
function knownUsage(usage: SemanticJudgmentUsage): usage is DotSemanticKnownUsage {
  return (
    (usage.usage_status === 'reported' || usage.usage_status === 'not_invoked') &&
    Number.isInteger(usage.input_tokens) &&
    Number(usage.input_tokens) >= 0 &&
    Number.isInteger(usage.output_tokens) &&
    Number(usage.output_tokens) >= 0
  );
}

/** Budget operations are short synchronous transactions; catch rejected malformed returns. */
function synchronousBudgetResult<T>(value: T): T {
  if (
    value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  ) {
    void Promise.resolve(value).catch(() => undefined);
    throw new Error('Budget transaction returned an asynchronous value');
  }
  return value;
}

/**
 * Off and missing qualified fixture ports do nothing. Baseline dispatch must already have
 * finished. Outputs are diagnostics only; original proposals are never returned or mutated.
 */
async function observeDotSemanticJudgmentInternal(
  input: DotSemanticJudgmentInput,
  deps: DotSemanticJudgmentDeps = {}
): Promise<DotSemanticObservation[]> {
  if (input.mode === 'off') return [];
  const diagnostic = (reason: string): DotSemanticObservation[] => [
    {
      proposal_index: -1,
      status: 'skipped',
      reason,
      budget_status: 'not_reserved',
      additional_model_calls: 0,
    },
  ];
  const { now, schedule, canEvaluate, prepare, budget, invoke, persist } = deps;
  if (input.mode !== 'shadow') return diagnostic('invalid_mode');
  if (
    !now ||
    !schedule ||
    !canEvaluate ||
    !prepare ||
    !budget ||
    budget.mode !== 'offline_fixture' ||
    !invoke ||
    invoke.mode !== 'offline_fixture' ||
    !persist
  )
    return diagnostic('qualified_ports_unavailable');
  let parent: DotSemanticParent;
  let proposals: DotProposal[];
  let owner: DotSemanticBudgetOwner;
  let deadline: number;
  let parentFingerprint: string;
  try {
    parentFingerprint = judgmentCanonicalHash(input.parent);
    const parsedParent = parentSchema.parse(input.parent);
    parent = { ...parsedParent, scope: judgmentScopeSchema.parse(input.parent.scope) };
    if (
      Object.keys(input).some((field) => !['mode', 'parent', 'proposals', 'signal'].includes(field))
    )
      return diagnostic('invalid_contract');
    if (!Array.isArray(input.proposals) || input.proposals.length > 10)
      return diagnostic('invalid_contract');
    proposals = structuredClone(input.proposals);
    const started = now();
    if (
      !Number.isFinite(started) ||
      !Number.isFinite(new Date(started).getTime()) ||
      !Number.isFinite(new Date(parent.deadline_ms).getTime())
    )
      return diagnostic('invalid_clock');
    if (parent.day !== new Date(started).toISOString().slice(0, 10))
      return diagnostic('stale_parent_day');
    deadline = Math.min(parent.deadline_ms, started + 15_000);
    if (deadline <= started || input.signal?.aborted || !canEvaluate())
      return diagnostic('evaluation_not_active');
    owner = {
      dot_id: parent.dot_id,
      accounting_id: parent.accounting_id,
      scope_hash: judgmentCanonicalHash(parent.scope),
      day: parent.day,
    };
    const current = getUsageAttribution();
    if (
      current &&
      (current.actor_id !== `dot:${parent.dot_id}` ||
        current.accounting_id !== parent.accounting_id ||
        judgmentCanonicalHash(current.scope) !==
          judgmentCanonicalHash(normalizeEventScope(parent.scope)))
    )
      return diagnostic('parent_attribution_mismatch');
  } catch {
    return diagnostic('invalid_contract');
  }

  return withUsageAttribution(
    { actor_id: `dot:${parent.dot_id}`, accounting_id: parent.accounting_id, scope: parent.scope },
    async () => {
      const observations: DotSemanticObservation[] = [];
      const active = (): boolean => {
        try {
          return (
            judgmentCanonicalHash(input.parent) === parentFingerprint &&
            !input.signal?.aborted &&
            now() < deadline &&
            parent.day === new Date(now()).toISOString().slice(0, 10) &&
            canEvaluate()
          );
        } catch {
          return false;
        }
      };
      for (const [index, proposal] of proposals.entries()) {
        if (!active()) {
          observations.push({
            proposal_index: index,
            status: 'skipped',
            reason: 'evaluation_not_active',
            budget_status: 'not_reserved',
            additional_model_calls: 0,
          });
          break;
        }
        let prepared: PreparedDotSemanticJudgment;
        try {
          const candidate = prepare(structuredClone(proposal), structuredClone(parent));
          prepared = { ...candidate, request: structuredClone(candidate.request) };
          tokenLimit.parse(prepared.requested_total_tokens);
          const binding = judgmentBindingSchema.parse(prepared.request.context.binding);
          if (
            binding.scope_hash !== owner.scope_hash ||
            judgmentCanonicalHash(prepared.request.context.scope) !== owner.scope_hash ||
            typeof prepared.readCurrentContext !== 'function'
          )
            throw new Error('Prepared context does not belong to the parent');
        } catch {
          observations.push({
            proposal_index: index,
            status: 'unavailable',
            reason: 'preparation_failed',
            budget_status: 'not_reserved',
            additional_model_calls: 0,
          });
          continue;
        }
        if (!active()) {
          observations.push({
            proposal_index: index,
            status: 'skipped',
            reason: 'evaluation_not_active',
            budget_status: 'not_reserved',
            additional_model_calls: 0,
          });
          break;
        }
        let reservation: Extract<
          ReturnType<DotSemanticSharedBudgetPort['reserve']>,
          { status: 'reserved' }
        >;
        let ownedReservation: typeof reservation | undefined;
        try {
          const result = synchronousBudgetResult(
            budget.reserve({
              parent: structuredClone(owner),
              reservation_key: judgmentCanonicalHash({
                parent: owner,
                binding: prepared.request.context.binding,
                proposal_index: index,
              }),
              max_tokens: prepared.requested_total_tokens,
            })
          );
          if (result.status !== 'reserved') {
            observations.push({
              proposal_index: index,
              status: 'skipped',
              reason: 'shared_parent_budget_unavailable',
              budget_status: 'not_reserved',
              additional_model_calls: 0,
            });
            continue;
          }
          // Copy the container, preserving only the issuer's exact opaque handle identity.
          reservation = {
            status: 'reserved',
            handle: result.handle,
            owner: result.owner,
            token_allowance: result.token_allowance,
          };
          if (
            !reservation.handle ||
            typeof reservation.handle !== 'object' ||
            Array.isArray(reservation.handle) ||
            judgmentCanonicalHash(ownerSchema.parse(reservation.owner)) !==
              judgmentCanonicalHash(owner)
          ) {
            observations.push({
              proposal_index: index,
              status: 'unavailable',
              reason: 'reservation_owner_mismatch',
              budget_status: 'foreign_reservation',
              additional_model_calls: 0,
            });
            continue;
          }
          ownedReservation = reservation;
          tokenLimit.parse(reservation.token_allowance);
          if (reservation.token_allowance > prepared.requested_total_tokens)
            throw new Error('Reservation exceeds requested shared allowance');
        } catch {
          let state: DotSemanticObservation['budget_status'] = 'settlement_failed';
          if (ownedReservation) {
            try {
              state =
                synchronousBudgetResult(
                  budget.holdUnknown(ownedReservation.handle, structuredClone(owner))
                ).status === 'held_unknown'
                  ? 'held_unknown'
                  : 'settlement_failed';
            } catch {
              state = 'settlement_failed';
            }
          }
          observations.push({
            proposal_index: index,
            status: 'unavailable',
            reason: 'reservation_failed',
            budget_status: state,
            additional_model_calls: 0,
          });
          continue;
        }
        const reservationHandle = reservation.handle;
        const grantedAllowance = reservation.token_allowance;

        const observed = await new Promise<DotSemanticObservation>((resolve) => {
          let phase: 'waiting' | 'completed' | 'detached' = 'waiting';
          let actualCalls = 0;
          let finalSettled = false;
          let heldUnknown = false;
          let cancelOuter: (() => void) | undefined;
          const controller = new AbortController();
          let cancelCause: 'parent_cancelled' | 'observer_deadline' | undefined;
          const onParentAbort = (): void => {
            cancelCause ??= 'parent_cancelled';
            controller.abort(cancelCause);
          };
          input.signal?.addEventListener('abort', onParentAbort, { once: true });
          const cleanup = (): void => {
            cancelOuter?.();
            input.signal?.removeEventListener('abort', onParentAbort);
          };
          const account = (
            usage: SemanticJudgmentUsage
          ): DotSemanticObservation['budget_status'] => {
            if (finalSettled) return 'settled';
            try {
              if (knownUsage(usage)) {
                if (
                  synchronousBudgetResult(
                    budget.settle(reservationHandle, structuredClone(owner), usage)
                  ).status !== 'settled'
                )
                  throw new Error('Settlement not acknowledged');
                finalSettled = true;
                return 'settled';
              }
              if (!heldUnknown) {
                if (
                  synchronousBudgetResult(
                    budget.holdUnknown(reservationHandle, structuredClone(owner))
                  ).status !== 'held_unknown'
                )
                  throw new Error('Unknown usage hold not acknowledged');
                heldUnknown = true;
              }
              return 'held_unknown';
            } catch {
              return 'settlement_failed';
            }
          };
          const unknown: SemanticJudgmentUsage = {
            calls: 1,
            input_tokens: null,
            output_tokens: null,
            elapsed_ms: 0,
            usage_status: 'unavailable',
          };
          const timeout = (): void => {
            if (phase !== 'waiting') return;
            phase = 'detached';
            cancelCause ??= 'observer_deadline';
            controller.abort(cancelCause);
            const usage = actualCalls === 0 ? noUsage() : unknown;
            const state = account(usage);
            cleanup();
            resolve({
              proposal_index: index,
              status: actualCalls === 0 ? 'skipped' : 'pending_stop',
              reason: cancelCause,
              budget_status: state,
              additional_model_calls: actualCalls,
              stop_confirmed: actualCalls === 0,
              usage,
            });
          };
          try {
            if (!active()) {
              phase = 'completed';
              cleanup();
              resolve({
                proposal_index: index,
                status: 'skipped',
                reason: 'evaluation_not_active',
                budget_status: account(noUsage()),
                additional_model_calls: 0,
                stop_confirmed: true,
                usage: noUsage(),
              });
              return;
            }
            if (input.signal?.aborted) onParentAbort();
            const evidenceDeps: JudgmentEvidenceDeps = {
              now,
              readCurrentContext: prepared.readCurrentContext,
              ...(prepared.createTrace ? { createTrace: prepared.createTrace } : {}),
            };
            // The outer timer may detach a broken provider. It never certifies that provider stopped.
            cancelOuter = schedule(timeout, Math.max(0, deadline - now()));
            if (phase !== 'waiting') return;
            const task = assessSemanticJudgment(
              {
                ...prepared.request.context,
                mode: 'offline_fixture',
                parentDeadlineMs: deadline,
                parentTokenAllowance: grantedAllowance,
                maxOutputTokens: prepared.request.modelConfig.maxOutputTokens,
                signal: controller.signal,
              },
              {
                now,
                schedule,
                readCurrentContext: prepared.readCurrentContext,
                port: {
                  mode: 'offline_fixture',
                  get provider() {
                    return invoke.provider;
                  },
                  get model() {
                    return invoke.model;
                  },
                  invoke: (request) => {
                    if (phase === 'detached' || invoke.mode !== 'offline_fixture' || !active())
                      return Promise.reject(
                        new Error('Observer no longer permits starting a fixture invocation')
                      );
                    actualCalls++;
                    return invoke.invoke(request);
                  },
                },
              }
            );
            void task
              .then(
                (result) => {
                  const usage = actualCalls === 0 ? noUsage() : result.usage;
                  const state = account(usage);
                  if (phase === 'detached') return; // Late usage may settle; late assessments never persist.
                  phase = 'completed';
                  cleanup();
                  if (state !== 'settled') {
                    resolve({
                      proposal_index: index,
                      status: 'unavailable',
                      reason: 'usage_not_settled',
                      budget_status: state,
                      additional_model_calls: actualCalls,
                      stop_confirmed: true,
                      usage,
                    });
                    return;
                  }
                  if (result.assessment.status !== 'evaluated' || !active()) {
                    resolve({
                      proposal_index: index,
                      status: 'unavailable',
                      reason:
                        result.assessment.status === 'unavailable'
                          ? result.assessment.reason
                          : 'evaluation_not_active',
                      budget_status: state,
                      additional_model_calls: actualCalls,
                      stop_confirmed: true,
                      usage,
                    });
                    return;
                  }
                  try {
                    const persisted = persist(
                      {
                        ...prepared.request,
                        result,
                        parentTokenAllowance: grantedAllowance,
                      },
                      evidenceDeps
                    );
                    resolve(
                      persisted.status === 'persisted' && active()
                        ? {
                            proposal_index: index,
                            status: 'observed',
                            reason: 'receipt_recorded',
                            budget_status: state,
                            additional_model_calls: actualCalls,
                            stop_confirmed: true,
                            usage,
                            receipt: persisted.reference,
                          }
                        : {
                            proposal_index: index,
                            status: 'unavailable',
                            reason: 'receipt_unavailable',
                            budget_status: state,
                            additional_model_calls: actualCalls,
                            stop_confirmed: true,
                            usage,
                          }
                    );
                  } catch {
                    resolve({
                      proposal_index: index,
                      status: 'unavailable',
                      reason: 'receipt_failed',
                      budget_status: state,
                      additional_model_calls: actualCalls,
                      stop_confirmed: true,
                      usage,
                    });
                  }
                },
                () => {
                  const state = account(actualCalls === 0 ? noUsage() : unknown);
                  if (phase !== 'waiting') return;
                  phase = 'completed';
                  cleanup();
                  resolve({
                    proposal_index: index,
                    status: 'unavailable',
                    reason: 'evaluation_failed',
                    budget_status: state,
                    additional_model_calls: actualCalls,
                    stop_confirmed: actualCalls === 0,
                  });
                }
              )
              .catch(() => {
                if (phase !== 'waiting') return;
                phase = 'completed';
                cleanup();
                resolve({
                  proposal_index: index,
                  status: 'unavailable',
                  reason: 'observer_failed',
                  budget_status: account(actualCalls === 0 ? noUsage() : unknown),
                  additional_model_calls: actualCalls,
                  stop_confirmed: actualCalls === 0,
                });
              });
          } catch {
            phase = 'completed';
            cleanup();
            resolve({
              proposal_index: index,
              status: 'unavailable',
              reason: 'observer_failed',
              budget_status: account(actualCalls === 0 ? noUsage() : unknown),
              additional_model_calls: actualCalls,
              stop_confirmed: actualCalls === 0,
            });
          }
        });
        observations.push(observed);
        if (observed.status === 'pending_stop') break;
      }
      return observations;
    }
  );
}

/** Broken injected contracts are diagnostics, never failures of the already-completed baseline. */
export async function observeDotSemanticJudgment(
  input: DotSemanticJudgmentInput,
  deps: DotSemanticJudgmentDeps = {}
): Promise<DotSemanticObservation[]> {
  try {
    return await observeDotSemanticJudgmentInternal(input, deps);
  } catch {
    return [
      {
        proposal_index: -1,
        status: 'unavailable',
        reason: 'observer_contract_failed',
        budget_status: 'settlement_failed',
        additional_model_calls: null,
      },
    ];
  }
}
