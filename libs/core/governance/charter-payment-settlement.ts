/**
 * Governed payment provider integration. No payment provider ships here.
 * Adapters are trusted host dependencies, never functions/policy supplied by ADF.
 * An attempted identity is never automatically executed twice, even after a crash.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { assertSafeRepositoryPath, safeMkdir } from '../secure-io.js';
import { runCharterGate, type CharterGateRequest } from './approval-gate-charter.js';
import {
  charterDir,
  findActiveCharter,
  readCharter,
  releaseCharterPaymentReservation,
  withCharterDecisionLock,
  type CharterPathOptions,
} from './accountability-charter-registry.js';
import type { CharterScope } from './accountability-charter.js';

export interface CharterPaymentIntent {
  /** Durable business identity, stable across task/process retries and charter amendments. */
  payment_id: string;
  recipient: string;
  description: string;
}

export interface CharterPaymentExecution extends CharterPaymentIntent {
  /** Scope-bound key that the provider must use for its own idempotency. */
  idempotency_key: string;
  amount: number;
  currency: string;
}

export type CharterPaymentResolution =
  'succeeded' | 'not_executed' | 'compensated' | 'partial' | 'unknown';

export interface CharterPaymentReceipt {
  resolution: CharterPaymentResolution;
  idempotency_key: string;
  recipient: string;
  amount: number;
  currency: string;
  /** Durable provider receipt/query evidence, not an agent's assertion of success. */
  evidence_ref: string;
  /** For non-execution/full compensation: the provider has permanently closed
   * this idempotency key against any pending or later submission. A transient
   * "not found" lookup is unknown, never sufficient to release a reservation. */
  execution_closed: boolean;
}

export interface CharterPaymentAdapter {
  /** Stable provider/account identity; changing it for an existing payment is rejected. */
  id: string;
  /** Must enforce idempotency at the provider, including reconciliation closure. */
  execute(payment: Readonly<CharterPaymentExecution>): Promise<CharterPaymentReceipt>;
  /** Read-only authoritative provider lookup; must never submit/retry/refund a payment. */
  reconcile(payment: Readonly<CharterPaymentExecution>): Promise<CharterPaymentReceipt>;
}

export interface CharterPaymentState {
  payment: CharterPaymentExecution;
  adapter_id: string;
  charter_id: string;
  intent_hash: string;
  status: 'authorizing' | 'executing' | 'blocked' | CharterPaymentResolution;
  updated_at: string;
  evidence_ref?: string;
  reason?: string;
}

export interface ExecuteCharterPaymentInput {
  intent: CharterPaymentIntent;
  gate: Omit<CharterGateRequest, 'correlationId' | 'expectedCharterId'>;
  adapter: CharterPaymentAdapter;
}

function paymentKey(scope: CharterScope, paymentId: string): string {
  if (!paymentId.trim() || paymentId.length > 200) throw new Error('[payment] invalid payment_id');
  return createHash('sha256')
    .update(
      JSON.stringify([
        scope.kind,
        scope.kind === 'organization' ? scope.tenant_slug : null,
        paymentId,
      ])
    )
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item
  );
}

function logPath(scope: CharterScope, paymentId: string, options: CharterPathOptions): string {
  return assertSafeRepositoryPath(
    path.join(charterDir(scope, options), `${paymentKey(scope, paymentId)}.payment.jsonl`),
    { allowMissingLeaf: true, rootDir: options.rootDir }
  );
}

export function readCharterPayment(
  scope: CharterScope,
  paymentId: string,
  options: CharterPathOptions = {}
): CharterPaymentState | null {
  const entries = readJsonLines<CharterPaymentState>(logPath(scope, paymentId, options));
  for (const [index, entry] of entries.entries()) {
    const previous = entries[index - 1];
    if (
      !entry ||
      typeof entry !== 'object' ||
      !entry.payment ||
      entry.payment.payment_id !== paymentId ||
      entry.payment.idempotency_key !== `charter-payment:${paymentKey(scope, paymentId)}` ||
      !Number.isFinite(entry.payment.amount) ||
      !(entry.payment.amount > 0) ||
      typeof entry.payment.currency !== 'string' ||
      !entry.payment.currency.trim() ||
      typeof entry.payment.recipient !== 'string' ||
      !entry.payment.recipient.trim() ||
      typeof entry.payment.description !== 'string' ||
      !entry.payment.description.trim() ||
      typeof entry.adapter_id !== 'string' ||
      !entry.adapter_id.trim() ||
      typeof entry.charter_id !== 'string' ||
      !entry.charter_id.trim() ||
      !/^[a-f0-9]{64}$/.test(entry.intent_hash) ||
      !Number.isFinite(Date.parse(entry.updated_at)) ||
      ![
        'authorizing',
        'executing',
        'blocked',
        'succeeded',
        'not_executed',
        'compensated',
        'partial',
        'unknown',
      ].includes(entry.status) ||
      (['not_executed', 'compensated'].includes(entry.status) && !entry.evidence_ref?.trim()) ||
      entry.intent_hash !== entries[0]!.intent_hash ||
      entry.adapter_id !== entries[0]!.adapter_id ||
      (previous &&
        entry.charter_id !== previous.charter_id &&
        !(
          previous.status === 'blocked' &&
          entry.status === 'authorizing' &&
          entries
            .slice(0, index)
            .every((record) => ['authorizing', 'blocked'].includes(record.status))
        )) ||
      canonicalJson(entry.payment) !== canonicalJson(entries[0]!.payment)
    ) {
      throw new Error('[payment] corrupt durable payment state; execution is stopped');
    }
  }
  return entries.at(-1) ?? null;
}

function append(
  scope: CharterScope,
  state: CharterPaymentState,
  options: CharterPathOptions
): void {
  const file = logPath(scope, state.payment.payment_id, options);
  safeMkdir(path.dirname(file), { recursive: true });
  appendJsonLine(file, state);
}

function assertAdapter(adapter: CharterPaymentAdapter): void {
  if (
    !adapter.id.trim() ||
    typeof adapter.execute !== 'function' ||
    typeof adapter.reconcile !== 'function'
  ) {
    throw new Error('[payment] a trusted execution/reconciliation adapter is required');
  }
}

function releaseResolved(
  scope: CharterScope,
  state: CharterPaymentState,
  options: CharterPathOptions
): void {
  if (state.status !== 'not_executed' && state.status !== 'compensated') return;
  const charter = readCharter(scope, state.charter_id, options);
  if (!charter) throw new Error('[payment] reservation charter missing; budget remains reserved');
  releaseCharterPaymentReservation(
    charter,
    state.payment.idempotency_key,
    {
      resolution: state.status,
      evidence_ref: state.evidence_ref!,
    },
    options
  );
}

function applyReceipt(
  scope: CharterScope,
  original: CharterPaymentState,
  receipt: CharterPaymentReceipt,
  options: CharterPathOptions
): CharterPaymentState {
  const p = original.payment;
  if (
    !receipt ||
    !['succeeded', 'not_executed', 'compensated', 'partial', 'unknown'].includes(
      receipt.resolution
    ) ||
    receipt.idempotency_key !== p.idempotency_key ||
    receipt.recipient !== p.recipient ||
    receipt.amount !== p.amount ||
    receipt.currency !== p.currency ||
    !receipt.evidence_ref?.trim()
  ) {
    throw new Error('[payment] provider receipt is not bound to the full payment intent');
  }
  if (
    ['not_executed', 'compensated'].includes(receipt.resolution) &&
    receipt.execution_closed !== true
  ) {
    throw new Error('[payment] release requires authoritative permanent execution closure');
  }
  const result = withCharterDecisionLock(scope, () => {
    const current = readCharterPayment(scope, p.payment_id, options)!;
    // Late queries must never reverse a known charge or release partial spend.
    if (['not_executed', 'compensated', 'blocked'].includes(current.status)) return current;
    if (current.status === 'succeeded' && receipt.resolution !== 'compensated') return current;
    if (
      current.status === 'partial' &&
      !['succeeded', 'compensated', 'partial'].includes(receipt.resolution)
    )
      return current;
    const state: CharterPaymentState = {
      ...current,
      status: receipt.resolution,
      evidence_ref: receipt.evidence_ref,
      updated_at: new Date().toISOString(),
    };
    append(scope, state, options);
    return state;
  });
  // If the process dies here, the terminal state is durable. A subsequent
  // execute/reconcile replays this idempotent release, never the payment.
  releaseResolved(scope, result, options);
  return result;
}

/**
 * Reserve through the real charter gate, then call a trusted provider once.
 * Uncertain/partial/crashed attempts require reconcile; retries never execute.
 * A charter denial returns blocked, leaving ordinary human approval to the
 * caller's approval workflow; no external payment has been attempted. A newly
 * human-accepted charter can reauthorize only those blocked, unattempted intents.
 */
export async function executeCharterPayment(
  input: ExecuteCharterPaymentInput
): Promise<CharterPaymentState> {
  assertAdapter(input.adapter);
  const { gate, intent, adapter } = input;
  const scope = gate.charter.scope;
  const options = gate.charter.pathOptions ?? {};
  const action = gate.charter.action;
  if (
    action.action_class !== 'payment' ||
    !Number.isFinite(action.amount) ||
    !(action.amount! > 0) ||
    !action.currency?.trim() ||
    !intent.recipient.trim() ||
    !intent.description.trim()
  ) {
    throw new Error('[payment] priced payment action, recipient and description are required');
  }
  const payment: CharterPaymentExecution = {
    ...intent,
    amount: action.amount!,
    currency: action.currency,
    idempotency_key: `charter-payment:${paymentKey(scope, intent.payment_id)}`,
  };
  const hash = createHash('sha256')
    .update(canonicalJson({ payment, action, adapter: adapter.id }))
    .digest('hex');
  const claimed = withCharterDecisionLock(scope, () => {
    const existing = readCharterPayment(scope, intent.payment_id, options);
    if (existing) {
      if (existing.intent_hash !== hash)
        throw new Error('[payment] identity reused for different intent/provider');
      // A denial made no external attempt. An accountable human's newly
      // accepted charter may authorize that same immutable invoice. Every
      // attempted/uncertain/settled identity remains permanently non-retryable.
      if (existing.status === 'blocked') {
        const amended = findActiveCharter(scope, gate.now ?? new Date(), options);
        if (amended && amended.charter_id !== existing.charter_id) {
          const reauthorized: CharterPaymentState = {
            ...existing,
            charter_id: amended.charter_id,
            status: 'authorizing',
            updated_at: new Date().toISOString(),
            reason: undefined,
          };
          append(scope, reauthorized, options);
          return { state: reauthorized, owned: true };
        }
      }
      return { state: existing, owned: false };
    }
    const active = findActiveCharter(scope, gate.now ?? new Date(), options);
    if (!active)
      throw new Error('[payment] active charter required; use the human approval workflow');
    const state: CharterPaymentState = {
      payment,
      adapter_id: adapter.id,
      charter_id: active.charter_id,
      intent_hash: hash,
      status: 'authorizing',
      updated_at: new Date().toISOString(),
    };
    append(scope, state, options);
    return { state, owned: true };
  });
  if (!claimed.owned) {
    releaseResolved(scope, claimed.state, options);
    return claimed.state;
  }
  let state = claimed.state;
  try {
    const decision = runCharterGate({
      ...gate,
      correlationId: payment.idempotency_key,
      expectedCharterId: state.charter_id,
    });
    state = withCharterDecisionLock(scope, () => {
      const current = readCharterPayment(scope, intent.payment_id, options)!;
      // A different process may have reconciled while authorization was
      // running. Never overwrite its authoritative state or submit afterwards.
      if (current.status !== 'authorizing') return current;
      const next: CharterPaymentState = {
        ...state,
        status: decision.kind === 'allow' ? 'executing' : 'blocked',
        reason: decision.kind === 'require_approval' ? decision.reason : decision.kind,
        updated_at: new Date().toISOString(),
      };
      append(scope, next, options);
      return next;
    });
    if (state.status !== 'executing') {
      releaseResolved(scope, state, options);
      return state;
    }
    return applyReceipt(
      scope,
      state,
      await adapter.execute(Object.freeze({ ...payment })),
      options
    );
  } catch {
    // Exceptions may follow an actual charge or a persisted reservation. Never
    // infer non-execution from transport failure and never refund on a timer.
    return withCharterDecisionLock(scope, () => {
      const current = readCharterPayment(scope, intent.payment_id, options)!;
      if (!['authorizing', 'executing'].includes(current.status)) return current;
      const uncertain: CharterPaymentState = {
        ...current,
        status: 'unknown',
        reason: 'authorization/execution outcome requires authoritative reconciliation',
        updated_at: new Date().toISOString(),
      };
      append(scope, uncertain, options);
      return uncertain;
    });
  }
}

/** Query an existing intent through its original trusted provider; never retries execution. */
export async function reconcileCharterPayment(
  scope: CharterScope,
  paymentId: string,
  adapter: CharterPaymentAdapter,
  options: CharterPathOptions = {}
): Promise<CharterPaymentState> {
  assertAdapter(adapter);
  const state = readCharterPayment(scope, paymentId, options);
  if (!state || state.adapter_id !== adapter.id)
    throw new Error('[payment] payment/provider not found in this scope');
  if (['not_executed', 'compensated', 'blocked'].includes(state.status)) {
    releaseResolved(scope, state, options);
    return state;
  }
  return applyReceipt(
    scope,
    state,
    await adapter.reconcile(Object.freeze({ ...state.payment })),
    options
  );
}
