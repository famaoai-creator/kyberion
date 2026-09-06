/**
 * Manual action boundary for an agent runtime (PI-14).
 *
 * The planner owns the next action, while this module owns the operator-facing
 * step boundary. `peekAction()` is read-only with respect to the action itself:
 * it never invokes the action executor. `executeAction()` advances exactly one
 * action. In `auto` mode `run()` repeats that same one-action boundary until it
 * reaches an idle or approval-blocked state; in `step` mode it only exposes
 * the next action so a surface can decide when to advance.
 *
 * Tool actions always pass through the supplied approval gate at peek time and
 * are checked again immediately before execution. The second check prevents a
 * stale peek result from becoming authority to execute a changed approval.
 */

import {
  enforceApprovalGate,
  type ApprovalGateParams,
  type ApprovalGateResult,
} from './approval-gate.js';
import { normalizeEventScope, type EventScope, type EventScopeInput } from './event-scope.js';
import { startManualDriverBridge } from './agent-runtime-manual-drive-bridge.js';

export const MANUAL_DRIVE_ACTION_KINDS = [
  'append_entry',
  'stream_assistant',
  'execute_tool',
  'hook',
  'sleep',
  'apply_pending_write',
  'consume_queue_item',
] as const;

export type ManualDriveActionKind = (typeof MANUAL_DRIVE_ACTION_KINDS)[number];

export type ManualDriveActionStatus = 'ready' | 'awaiting_approval' | 'blocked';

export type ManualDriveExecutionStatus =
  'executed' | 'awaiting_approval' | 'blocked' | 'failed' | 'idle';

export type ManualDriveMode = 'auto' | 'step';

export interface ManualDriveActionInfo {
  action_id: string;
  kind: ManualDriveActionKind;
  title: string;
  description?: string;
  operation_id?: string;
  requires_approval?: boolean;
  status: ManualDriveActionStatus;
  approval?: {
    status: 'approved' | 'pending' | 'denied';
    request_id?: string;
    message?: string;
  };
}

/** Short contract name used by operator/surface integrations. */
export type ActionInfo = ManualDriveActionInfo;

export interface ManualDriveApprovalDecision {
  status: 'approved' | 'pending' | 'denied';
  request_id?: string;
  message?: string;
}

export interface ManualDriveApprovalContext {
  action: ManualDriveActionInfo;
  phase: 'peek' | 'execute';
  /** Sensitive tool input for approval binding; never returned in ActionInfo. */
  approval_payload?: Record<string, unknown>;
}

export type ManualDriveApprovalGate = (
  context: ManualDriveApprovalContext
) => ManualDriveApprovalDecision | Promise<ManualDriveApprovalDecision>;

export interface ManualDriveExecutionContext {
  action: ManualDriveActionInfo;
  approval?: ManualDriveApprovalDecision;
}

export interface ManualDriveActionPlan {
  action_id: string;
  kind: ManualDriveActionKind;
  title: string;
  description?: string;
  operation_id?: string;
  requires_approval?: boolean;
  /** Kept out of `ActionInfo`; only the approval adapter receives it. */
  approval_payload?: Record<string, unknown>;
  execute: (context: ManualDriveExecutionContext) => unknown | Promise<unknown>;
}

export interface ManualDriveActionProvider {
  nextAction: () => ManualDriveActionPlan | null | Promise<ManualDriveActionPlan | null>;
}

export interface ManualDriveOptions extends ManualDriveActionProvider {
  mode?: ManualDriveMode;
  approvalGate?: ManualDriveApprovalGate;
  /** Notifies a live controller when execution stops before the plan runs. */
  onExecutionResult?: (result: ManualDriveExecutionResult) => void;
}

export interface ManualDriveExecutionResult {
  status: ManualDriveExecutionStatus;
  action?: ManualDriveActionInfo;
  result?: unknown;
  error?: string;
  approval?: ManualDriveApprovalDecision;
}

export interface ManualDriveRunResult {
  mode: ManualDriveMode;
  actions: ManualDriveExecutionResult[];
  stop_reason: 'idle' | 'step' | 'awaiting_approval' | 'blocked' | 'max_actions';
  next_action: ManualDriveActionInfo | null;
}

export interface AgentRuntimeManualDriverRegistration {
  agentId: string;
  driver: AgentRuntimeManualDriver;
  scope: EventScope;
}

const MANUAL_DRIVER_REGISTRY_KEY = Symbol.for('kyberion.agentRuntimeManualDriverRegistry');

function manualDriverRegistry(): Map<string, AgentRuntimeManualDriverRegistration> {
  const globalState = globalThis as typeof globalThis & {
    [MANUAL_DRIVER_REGISTRY_KEY]?: Map<string, AgentRuntimeManualDriverRegistration>;
  };
  const current = globalState[MANUAL_DRIVER_REGISTRY_KEY];
  if (current) return current;
  const created = new Map<string, AgentRuntimeManualDriverRegistration>();
  globalState[MANUAL_DRIVER_REGISTRY_KEY] = created;
  return created;
}

/**
 * Register the process-local manual-drive provider for an agent runtime.
 *
 * The scope is mandatory because an HTTP surface must never turn an
 * unscoped runtime into an operator-visible control target. The returned
 * disposer only removes this exact registration, so a later owner cannot be
 * accidentally deregistered by an older worker during shutdown.
 */
export function registerAgentRuntimeManualDriver(input: {
  agentId: string;
  driver: AgentRuntimeManualDriver;
  scope: EventScopeInput;
  /** Publish a safe cross-process descriptor and consume durable commands. */
  durableControl?: boolean;
  durablePollIntervalMs?: number;
}): () => void {
  const agentId = input.agentId.trim();
  if (!agentId) throw new Error('[MANUAL_DRIVE_AGENT_ID] agentId is required.');
  if (
    !input.driver ||
    typeof input.driver.peekAction !== 'function' ||
    typeof input.driver.executeAction !== 'function'
  ) {
    throw new Error('[MANUAL_DRIVE_DRIVER_INVALID] driver must be an AgentRuntimeManualDriver.');
  }
  if (!input.scope || typeof input.scope !== 'object' || Object.keys(input.scope).length === 0) {
    throw new Error('[MANUAL_DRIVE_SCOPE_REQUIRED] a runtime scope is required.');
  }
  const scope = normalizeEventScope(input.scope);
  if (scope.scope_kind !== 'system' && !scope.tenant_slug) {
    throw new Error(
      '[MANUAL_DRIVE_SCOPE_TENANT_REQUIRED] non-system manual runtimes require tenant scope.'
    );
  }
  const registration: AgentRuntimeManualDriverRegistration = {
    agentId,
    driver: input.driver,
    scope,
  };
  const registry = manualDriverRegistry();
  if (registry.has(agentId)) {
    throw new Error(`[MANUAL_DRIVE_DUPLICATE] agent '${agentId}' is already registered.`);
  }
  registry.set(agentId, registration);
  let stopDurableBridge: (() => void) | undefined;
  try {
    if (input.durableControl) {
      stopDurableBridge = startManualDriverBridge({
        agentId,
        driver: input.driver,
        scope,
        ...(input.durablePollIntervalMs !== undefined
          ? { pollIntervalMs: input.durablePollIntervalMs }
          : {}),
      });
    }
  } catch (error) {
    registry.delete(agentId);
    throw error;
  }
  return () => {
    stopDurableBridge?.();
    if (registry.get(agentId) === registration) registry.delete(agentId);
  };
}

export function getAgentRuntimeManualDriverRegistration(
  agentId: string
): AgentRuntimeManualDriverRegistration | undefined {
  const normalized = agentId.trim();
  if (!normalized) return undefined;
  return manualDriverRegistry().get(normalized);
}

export async function peekRegisteredAgentRuntimeAction(
  agentId: string
): Promise<ManualDriveActionInfo | null> {
  const registration = getAgentRuntimeManualDriverRegistration(agentId);
  if (!registration) {
    throw new Error(
      `[MANUAL_DRIVE_RUNTIME_NOT_REGISTERED] agent '${agentId.trim()}' is not registered.`
    );
  }
  return registration.driver.peekAction();
}

export async function executeRegisteredAgentRuntimeAction(
  agentId: string,
  actionId?: string
): Promise<ManualDriveExecutionResult> {
  const registration = getAgentRuntimeManualDriverRegistration(agentId);
  if (!registration) {
    throw new Error(
      `[MANUAL_DRIVE_RUNTIME_NOT_REGISTERED] agent '${agentId.trim()}' is not registered.`
    );
  }
  return registration.driver.executeAction(actionId);
}

export {
  cancelManualDriverCommand,
  enqueueManualDriverCommand,
  resumeManualDriverCommand,
  readManualDriverCommandStatus,
  readManualDriverDescriptor,
  startManualDriverBridge,
} from './agent-runtime-manual-drive-bridge.js';

function isActionKind(value: unknown): value is ManualDriveActionKind {
  return (
    typeof value === 'string' && (MANUAL_DRIVE_ACTION_KINDS as readonly string[]).includes(value)
  );
}

/** Rebuild the operator-safe action shape at every process boundary. */
export function projectManualDriveActionInfo(value: unknown): ManualDriveActionInfo | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[MANUAL_DRIVE_INVALID_ACTION_INFO] action info must be an object or null.');
  }
  const raw = value as Partial<ManualDriveActionInfo>;
  if (
    typeof raw.action_id !== 'string' ||
    !raw.action_id.trim() ||
    !isActionKind(raw.kind) ||
    typeof raw.title !== 'string' ||
    !raw.title.trim() ||
    !['ready', 'awaiting_approval', 'blocked'].includes(raw.status)
  ) {
    throw new Error('[MANUAL_DRIVE_INVALID_ACTION_INFO] action info shape is invalid.');
  }
  if (
    (raw.description !== undefined && typeof raw.description !== 'string') ||
    (raw.operation_id !== undefined && typeof raw.operation_id !== 'string') ||
    (raw.requires_approval !== undefined && typeof raw.requires_approval !== 'boolean')
  ) {
    throw new Error('[MANUAL_DRIVE_INVALID_ACTION_INFO] action info optional fields are invalid.');
  }
  const approval = raw.approval;
  if (
    approval !== undefined &&
    (!approval ||
      !['approved', 'pending', 'denied'].includes(approval.status) ||
      (approval.request_id !== undefined && typeof approval.request_id !== 'string') ||
      (approval.message !== undefined && typeof approval.message !== 'string'))
  ) {
    throw new Error('[MANUAL_DRIVE_INVALID_ACTION_INFO] action approval shape is invalid.');
  }
  return {
    action_id: raw.action_id.trim(),
    kind: raw.kind,
    title: raw.title.trim(),
    ...(raw.description?.trim() ? { description: raw.description.trim() } : {}),
    ...(raw.operation_id?.trim() ? { operation_id: raw.operation_id.trim() } : {}),
    ...(raw.requires_approval !== undefined ? { requires_approval: raw.requires_approval } : {}),
    status: raw.status,
    ...(approval
      ? {
          approval: {
            status: approval.status,
            ...(approval.request_id?.trim() ? { request_id: approval.request_id.trim() } : {}),
            ...(approval.message?.trim() ? { message: approval.message.trim() } : {}),
          },
        }
      : {}),
  };
}

function normalizeActionPlan(plan: ManualDriveActionPlan): ManualDriveActionPlan {
  if (
    !plan ||
    typeof plan !== 'object' ||
    typeof plan.action_id !== 'string' ||
    !plan.action_id.trim() ||
    !isActionKind(plan.kind) ||
    typeof plan.title !== 'string' ||
    !plan.title.trim() ||
    typeof plan.execute !== 'function'
  ) {
    throw new Error('[MANUAL_DRIVE_INVALID_ACTION] action plan is incomplete.');
  }
  if (
    (plan.description !== undefined && typeof plan.description !== 'string') ||
    (plan.operation_id !== undefined && typeof plan.operation_id !== 'string') ||
    (plan.requires_approval !== undefined && typeof plan.requires_approval !== 'boolean') ||
    (plan.approval_payload !== undefined &&
      (!plan.approval_payload ||
        typeof plan.approval_payload !== 'object' ||
        Array.isArray(plan.approval_payload)))
  ) {
    throw new Error('[MANUAL_DRIVE_INVALID_ACTION] action plan optional fields are invalid.');
  }
  return {
    ...plan,
    action_id: plan.action_id.trim(),
    title: plan.title.trim(),
    ...(plan.description?.trim() ? { description: plan.description.trim() } : {}),
    ...(plan.operation_id?.trim() ? { operation_id: plan.operation_id.trim() } : {}),
  };
}

function toActionInfo(
  plan: ManualDriveActionPlan,
  status: ManualDriveActionStatus = 'ready',
  approval?: ManualDriveApprovalDecision
): ManualDriveActionInfo {
  return {
    action_id: plan.action_id,
    kind: plan.kind,
    title: plan.title,
    ...(plan.description ? { description: plan.description } : {}),
    ...(plan.operation_id ? { operation_id: plan.operation_id } : {}),
    ...(plan.requires_approval !== undefined ? { requires_approval: plan.requires_approval } : {}),
    status,
    ...(approval
      ? {
          approval: {
            status: approval.status,
            ...(approval.request_id ? { request_id: approval.request_id } : {}),
            ...(approval.message ? { message: approval.message } : {}),
          },
        }
      : {}),
  };
}

function resultForApproval(
  action: ManualDriveActionInfo,
  decision: ManualDriveApprovalDecision
): ManualDriveExecutionResult {
  const blocked = decision.status === 'denied';
  return {
    status: blocked ? 'blocked' : 'awaiting_approval',
    action: {
      ...action,
      status: blocked ? 'blocked' : 'awaiting_approval',
      approval: {
        status: decision.status,
        ...(decision.request_id ? { request_id: decision.request_id } : {}),
        ...(decision.message ? { message: decision.message } : {}),
      },
    },
    approval: decision,
  };
}

function normalizeApprovalDecision(
  value: ManualDriveApprovalDecision
): ManualDriveApprovalDecision {
  if (
    !value ||
    typeof value !== 'object' ||
    !['approved', 'pending', 'denied'].includes(value.status) ||
    (value.request_id !== undefined && typeof value.request_id !== 'string') ||
    (value.message !== undefined && typeof value.message !== 'string')
  ) {
    return {
      status: 'denied',
      message: '[MANUAL_DRIVE_INVALID_APPROVAL] approval gate returned an invalid decision.',
    };
  }
  return {
    status: value.status,
    ...(value.request_id?.trim() ? { request_id: value.request_id.trim() } : {}),
    ...(value.message?.trim() ? { message: value.message.trim() } : {}),
  };
}

function mapApprovalGateResult(result: ApprovalGateResult): ManualDriveApprovalDecision {
  if (!result.allowed) {
    // ApprovalGateResult keeps the legacy `pending` status for fail-closed
    // non-interactive boundaries. Manual drive must still distinguish that
    // terminal condition from a real operator approval request.
    const humanRequired = result.message?.startsWith('[HUMAN_REQUIRED]') === true;
    return {
      status: humanRequired || result.status !== 'pending' ? 'denied' : 'pending',
      ...(result.requestId ? { request_id: result.requestId } : {}),
      ...(result.message ? { message: result.message } : {}),
    };
  }
  return {
    status: 'approved',
    ...(result.requestId ? { request_id: result.requestId } : {}),
    ...(result.message ? { message: result.message } : {}),
  };
}

/** Adapt Kyberion's durable approval-store gate to the manual-drive seam. */
export function createApprovalBackedManualDriveGate(
  buildParams: (context: ManualDriveApprovalContext) => ApprovalGateParams,
  role?: Parameters<typeof enforceApprovalGate>[1]
): ManualDriveApprovalGate {
  return (context) => mapApprovalGateResult(enforceApprovalGate(buildParams(context), role));
}

export class AgentRuntimeManualDriver {
  readonly mode: ManualDriveMode;
  private readonly nextAction: ManualDriveActionProvider['nextAction'];
  private readonly approvalGate?: ManualDriveApprovalGate;
  private readonly onExecutionResult?: ManualDriveOptions['onExecutionResult'];
  private pendingPlan: ManualDriveActionPlan | null = null;
  private lastApproval: ManualDriveApprovalDecision | undefined;
  private peekInFlight: Promise<ManualDriveActionInfo | null> | null = null;
  private executionInFlight: Promise<ManualDriveExecutionResult> | null = null;

  constructor(options: ManualDriveOptions) {
    this.mode = options.mode ?? 'step';
    this.nextAction = options.nextAction;
    this.approvalGate = options.approvalGate;
    this.onExecutionResult = options.onExecutionResult;
  }

  async peekAction(): Promise<ManualDriveActionInfo | null> {
    if (this.peekInFlight) return this.peekInFlight;
    const peek = this.peekActionInternal();
    this.peekInFlight = peek;
    try {
      return await peek;
    } finally {
      if (this.peekInFlight === peek) this.peekInFlight = null;
    }
  }

  private async peekActionInternal(): Promise<ManualDriveActionInfo | null> {
    if (!this.pendingPlan) {
      const plan = await this.nextAction();
      if (!plan) return null;
      this.pendingPlan = normalizeActionPlan(plan);
      this.lastApproval = undefined;
    }

    const plan = this.pendingPlan;
    const base = toActionInfo(plan);
    if (plan.kind !== 'execute_tool') return base;
    if (!this.approvalGate) {
      return toActionInfo(plan, 'blocked', {
        status: 'denied',
        message: '[MANUAL_DRIVE_APPROVAL_GATE_MISSING] execute_tool requires an approval gate.',
      });
    }

    const decision = normalizeApprovalDecision(
      await this.approvalGate({
        action: base,
        phase: 'peek',
        ...(plan.approval_payload ? { approval_payload: plan.approval_payload } : {}),
      })
    );
    this.lastApproval = decision;
    return toActionInfo(
      plan,
      decision.status === 'approved'
        ? 'ready'
        : decision.status === 'pending'
          ? 'awaiting_approval'
          : 'blocked',
      decision
    );
  }

  /** Alias matching the runtime action contract wording. */
  async peek(): Promise<ActionInfo | null> {
    return this.peekAction();
  }

  async executeAction(actionId?: string): Promise<ManualDriveExecutionResult> {
    if (this.executionInFlight) {
      throw new Error('[MANUAL_DRIVE_REENTRANT] an action is already executing.');
    }
    const execution = this.executeActionInternal(actionId);
    this.executionInFlight = execution;
    try {
      const result = await execution;
      this.onExecutionResult?.(result);
      return result;
    } finally {
      if (this.executionInFlight === execution) this.executionInFlight = null;
    }
  }

  private async executeActionInternal(actionId?: string): Promise<ManualDriveExecutionResult> {
    const action = await this.peekAction();
    if (!action || !this.pendingPlan) return { status: 'idle' };
    if (actionId && action.action_id !== actionId) {
      throw new Error(
        `[MANUAL_DRIVE_ACTION_MISMATCH] expected ${action.action_id}, received ${actionId}.`
      );
    }
    if (action.status !== 'ready') {
      return {
        status: action.status,
        action,
        ...(this.lastApproval ? { approval: this.lastApproval } : {}),
      };
    }

    const plan = this.pendingPlan;
    let approval = this.lastApproval;
    if (plan.kind === 'execute_tool') {
      if (!this.approvalGate) {
        return resultForApproval(action, {
          status: 'denied',
          message: '[MANUAL_DRIVE_APPROVAL_GATE_MISSING] execute_tool requires an approval gate.',
        });
      }
      approval = normalizeApprovalDecision(
        await this.approvalGate({
          action,
          phase: 'execute',
          ...(plan.approval_payload ? { approval_payload: plan.approval_payload } : {}),
        })
      );
      this.lastApproval = approval;
      if (approval.status !== 'approved') return resultForApproval(action, approval);
    }

    try {
      const result = await plan.execute({ action, ...(approval ? { approval } : {}) });
      this.pendingPlan = null;
      this.lastApproval = undefined;
      return { status: 'executed', action, result, ...(approval ? { approval } : {}) };
    } catch (error) {
      this.pendingPlan = null;
      this.lastApproval = undefined;
      return {
        status: 'failed',
        action,
        error: error instanceof Error ? error.message : String(error),
        ...(approval ? { approval } : {}),
      };
    }
  }

  /** Execute one explicitly selected action. */
  async execute(actionId?: string): Promise<ManualDriveExecutionResult> {
    return this.executeAction(actionId);
  }

  async run(maxActions = 100): Promise<ManualDriveRunResult> {
    if (!Number.isSafeInteger(maxActions) || maxActions < 1) {
      throw new Error('[MANUAL_DRIVE_MAX_ACTIONS] maxActions must be a positive integer.');
    }
    if (this.mode === 'step') {
      return {
        mode: this.mode,
        actions: [],
        stop_reason: 'step',
        next_action: await this.peekAction(),
      };
    }

    const actions: ManualDriveExecutionResult[] = [];
    for (let index = 0; index < maxActions; index += 1) {
      const action = await this.peekAction();
      if (!action) {
        return { mode: this.mode, actions, stop_reason: 'idle', next_action: null };
      }
      if (action.status !== 'ready') {
        return {
          mode: this.mode,
          actions,
          stop_reason: action.status,
          next_action: action,
        };
      }
      const result = await this.executeAction(action.action_id);
      actions.push(result);
      if (result.status !== 'executed') {
        return {
          mode: this.mode,
          actions,
          stop_reason: result.status === 'awaiting_approval' ? 'awaiting_approval' : 'blocked',
          next_action: await this.peekAction(),
        };
      }
    }
    return {
      mode: this.mode,
      actions,
      stop_reason: 'max_actions',
      next_action: await this.peekAction(),
    };
  }
}

/**
 * Bridges a long-running worker to the step driver. The worker publishes one
 * action through `requestAction()` and waits; the operator-facing driver owns
 * the actual admission and invokes the supplied executor exactly once.
 */
export class ManualDriveActionController {
  readonly driver: AgentRuntimeManualDriver;
  private pending: {
    plan: ManualDriveActionPlan;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  } | null = null;

  constructor(options: { approvalGate?: ManualDriveApprovalGate } = {}) {
    this.driver = new AgentRuntimeManualDriver({
      mode: 'step',
      nextAction: () => this.pending?.plan ?? null,
      ...(options.approvalGate ? { approvalGate: options.approvalGate } : {}),
      onExecutionResult: (result) => {
        if (result.status === 'executed') return;
        const pending = this.pending;
        if (!pending) return;
        this.pending = null;
        // The worker must observe a terminal admission result instead of
        // waiting forever when an approval is pending or denied.
        pending.resolve(result);
      },
    });
  }

  requestAction(plan: ManualDriveActionPlan): Promise<unknown> {
    if (this.pending) throw new Error('[MANUAL_DRIVE_REENTRANT] an action is already waiting.');
    let resolveRequest!: (value: unknown) => void;
    let rejectRequest!: (reason?: unknown) => void;
    const request = new Promise<unknown>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const wrappedPlan: ManualDriveActionPlan = {
      ...plan,
      execute: async (context) => {
        try {
          const result = await plan.execute(context);
          resolveRequest(result);
          return result;
        } catch (error) {
          rejectRequest(error);
          throw error;
        }
      },
    };
    this.pending = { plan: wrappedPlan, resolve: resolveRequest, reject: rejectRequest };
    return request.finally(() => {
      if (this.pending?.plan === wrappedPlan) this.pending = null;
    });
  }

  cancel(reason = '[MANUAL_DRIVE_CANCELLED] worker manual drive was cancelled.') {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.reject(new Error(reason));
  }

  hasPendingAction(): boolean {
    return this.pending !== null;
  }
}
