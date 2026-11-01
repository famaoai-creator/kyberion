import {
  agentDesktopAvailability,
  endAgentDesktopSession,
  gcAgentDesktopSessions,
  runAgentDesktopCommand,
  type AgentDesktopResult,
} from '@agent/core/desktop-ax-bridge';
import { createApprovalRequest, loadApprovalRequest } from '@agent/core/governance';
import { approvalUsabilityRefusal } from '@agent/core/governance/approval-store';
import {
  dispositionFor,
  stampOutcome,
  type ComputerInteractionDelivery,
} from '@agent/core/computer-interaction-outcome';
import { randomUUID } from 'node:crypto';

/**
 * Optional `agent-desktop` AX-tree backend for `computer_interaction`.
 *
 * These ops exist only when the managed tool runtime is installed; absent
 * runtime yields a structured TOOL_UNAVAILABLE result, never a crash or a
 * silent fallback. Ref addressing requires the snapshot-qualified form
 * (`@<snapshot_id>:e<N>`) — bare refs are rejected before spawn, matching
 * both the upstream fail-closed contract and the computer-interaction
 * schema's `qualified_ref` pattern. Mutating ops pass through the same
 * approval workflow as the other destructive desktop actions.
 */

const QUALIFIED_REF = /^@[A-Za-z0-9_-]+:e[0-9]+$/;

/**
 * Upstream's 3s snapshot deadline is too tight for dense real-world trees —
 * a 597-element Finder window timed out on a live probe. Give AX ops a
 * saner floor while still letting callers bound it explicitly.
 */
const AX_DEFAULT_TIMEOUT_MS = 15_000;

export const AX_OBSERVATION_OPS = new Set([
  'ax_runtime_status',
  'ax_snapshot',
  'ax_find',
  'ax_list_windows',
  'ax_list_apps',
  'ax_list_displays',
  'ax_list_surfaces',
  'ax_list_notifications',
  'ax_get',
  'ax_is',
]);
/** Runtime lifecycle ops — no approval needed; they only seal/gc governed session state. */
export const AX_LIFECYCLE_OPS = new Set(['ax_session_end', 'ax_session_gc']);
/**
 * Navigation-class mutating ops — same risk profile as the ungated
 * mark/coordinate ops (`left_click`, `scroll`, `focus_window`): they move
 * or reveal UI state without committing a value change. No approval, per
 * the existing per-op policy this backend now adopts.
 */
export const AX_NAV_OPS = new Set([
  'ax_click',
  'ax_scroll',
  'ax_scroll_to',
  'ax_focus',
  'ax_expand',
  'ax_collapse',
]);
/**
 * Commit-class mutating ops — enter text, set/clear values, toggle state,
 * or invoke menus; a wrong target commits a real change, so these keep the
 * `wf_computer_destructive_v1` approval gate.
 */
export const AX_COMMIT_OPS = new Set([
  'ax_right_click',
  'ax_type',
  'ax_press',
  'ax_set_value',
  'ax_select',
  'ax_clear',
  'ax_toggle',
  'ax_check',
  'ax_uncheck',
]);
export const AX_MUTATING_OPS = new Set([...AX_NAV_OPS, ...AX_COMMIT_OPS]);
/** Observation commands that carry no session-scoped state. */
const AX_SESSION_INDEPENDENT_OPS = new Set([
  'ax_list_windows',
  'ax_list_apps',
  'ax_list_displays',
  'ax_list_surfaces',
  'ax_list_notifications',
]);
export const AX_OPS = new Set([...AX_OBSERVATION_OPS, ...AX_MUTATING_OPS, ...AX_LIFECYCLE_OPS]);

export function isAxInteraction(type: string): boolean {
  return AX_OPS.has(type);
}

interface AxInteraction {
  type: string;
  qualified_ref?: string;
  native_id?: string;
  application?: string;
  window_id?: string;
  role?: string;
  name?: string;
  value?: string;
  direction?: string;
  text?: string;
  key?: string;
  timeout_ms?: number;
  approval_request_id?: string;
  title?: string;
  task_session_id?: string;
  property?: string;
  limit?: number;
  surface?: string;
  wait_for?: string;
  wait_for_gone?: string;
}

export interface AxHandlerContext {
  sessionId: string;
  application?: string;
  emitPatch: (
    status: string,
    latestAction: string,
    detail?: string,
    target?: string,
    metadata?: Record<string, unknown>
  ) => void;
}

function unavailableResult(interaction: AxInteraction, detail?: string) {
  return {
    status: 'failed',
    results: [{ op: interaction.type, status: 'failed' }],
    code: 'TOOL_UNAVAILABLE',
    disposition: dispositionFor('not_delivered'),
    recovery: {
      strategy: 'install_tool_runtime',
      retryable: false,
      requires_fresh_observation: false,
    },
    context: {
      detail:
        detail ??
        'agent-desktop runtime is not installed; install via `pnpm tool:setup -- --tool agent_desktop --apply`',
    },
    total_steps: 1,
  };
}

function refArgs(interaction: AxInteraction): string[] | { error: string } {
  const ref = interaction.qualified_ref;
  if (!ref || !QUALIFIED_REF.test(ref)) {
    return {
      error:
        `${interaction.type} requires action.qualified_ref in snapshot-qualified form ` +
        '(@<snapshot_id>:e<N>); bare refs and cross-snapshot refs are refused',
    };
  }
  return [ref];
}

function scopeArgs(interaction: AxInteraction, application?: string): string[] {
  const args: string[] = [];
  const app = interaction.application || application;
  if (app) args.push('--app', app);
  if (interaction.window_id) args.push('--window-id', interaction.window_id);
  return args;
}

function buildArgs(interaction: AxInteraction, application?: string): string[] | { error: string } {
  const timeout = ['--timeout-ms', String(interaction.timeout_ms ?? AX_DEFAULT_TIMEOUT_MS)];
  switch (interaction.type) {
    case 'ax_snapshot': {
      const args = ['snapshot', ...scopeArgs(interaction, application)];
      if (interaction.surface) args.push('--surface', interaction.surface);
      if (interaction.wait_for) args.push('--wait-for', interaction.wait_for);
      if (interaction.wait_for_gone) args.push('--wait-for-gone', interaction.wait_for_gone);
      args.push(...timeout);
      return args;
    }
    case 'ax_list_windows':
      return ['list-windows', ...timeout];
    case 'ax_list_apps': {
      // list-apps honors --timeout-ms; the other inventory commands do not.
      const args = ['list-apps'];
      if (interaction.application || application) {
        args.push('--app', interaction.application ?? application ?? '');
      }
      args.push(...timeout);
      return args;
    }
    case 'ax_list_displays':
      return ['list-displays'];
    case 'ax_list_surfaces': {
      const args = ['list-surfaces'];
      if (interaction.application || application) {
        args.push('--app', interaction.application ?? application ?? '');
      }
      return args;
    }
    case 'ax_list_notifications': {
      const args = ['list-notifications'];
      if (interaction.application || application) {
        args.push('--app', interaction.application ?? application ?? '');
      }
      if (interaction.text) args.push('--text', interaction.text);
      if (interaction.limit) args.push('--limit', String(interaction.limit));
      return args;
    }
    case 'ax_find': {
      const args = ['find', ...scopeArgs(interaction, application)];
      if (interaction.surface) args.push('--surface', interaction.surface);
      if (interaction.wait_for) args.push('--wait-for', interaction.wait_for);
      if (interaction.wait_for_gone) args.push('--wait-for-gone', interaction.wait_for_gone);
      if (interaction.role) args.push('--role', interaction.role);
      if (interaction.name) args.push('--name', interaction.name);
      if (interaction.text) args.push('--text', interaction.text);
      if (interaction.native_id) args.push('--native-id', interaction.native_id);
      if (interaction.qualified_ref) {
        if (!QUALIFIED_REF.test(interaction.qualified_ref)) {
          return { error: 'ax_find --root requires a snapshot-qualified ref' };
        }
        args.push('--root', interaction.qualified_ref);
      }
      args.push(...timeout);
      return args;
    }
    case 'ax_get':
    case 'ax_is': {
      const ref = refArgs(interaction);
      if ('error' in ref) return ref;
      const command = interaction.type === 'ax_get' ? 'get' : 'is';
      const property = interaction.property || (interaction.type === 'ax_get' ? 'text' : 'visible');
      // get/is are live reads with no wait loop — upstream rejects --timeout-ms here.
      return [command, ...ref, '--property', property];
    }
    case 'ax_click':
    case 'ax_right_click': {
      const ref = refArgs(interaction);
      if ('error' in ref) return ref;
      const command = interaction.type === 'ax_click' ? 'click' : 'right-click';
      return [command, ...ref, ...timeout];
    }
    case 'ax_scroll_to':
    case 'ax_focus':
    case 'ax_clear':
    case 'ax_toggle':
    case 'ax_check':
    case 'ax_uncheck':
    case 'ax_expand':
    case 'ax_collapse': {
      const ref = refArgs(interaction);
      if ('error' in ref) return ref;
      return [interaction.type.slice(3), ...ref, ...timeout];
    }
    case 'ax_type': {
      const ref = refArgs(interaction);
      if ('error' in ref) return ref;
      if (typeof interaction.text !== 'string') return { error: 'ax_type requires action.text' };
      return ['type', ...ref, interaction.text, ...timeout];
    }
    case 'ax_press': {
      // Upstream press is app-scoped, not ref-scoped: `press <COMBO>` sends
      // keys to the app's focused element (optionally --app/--window-id).
      // It takes no --timeout-ms (no wait loop).
      if (!interaction.key) return { error: 'ax_press requires action.key' };
      return ['press', interaction.key, ...scopeArgs(interaction, application)];
    }
    case 'ax_scroll': {
      const ref = refArgs(interaction);
      if ('error' in ref) return ref;
      const direction = interaction.direction || 'down';
      if (!['up', 'down', 'left', 'right'].includes(direction)) {
        return { error: `ax_scroll direction must be up/down/left/right, got ${direction}` };
      }
      return ['scroll', ...ref, '--direction', direction, ...timeout];
    }
    case 'ax_set_value': {
      const ref = refArgs(interaction);
      if ('error' in ref) return ref;
      if (typeof interaction.value !== 'string')
        return { error: 'ax_set_value requires action.value' };
      return ['set-value', ...ref, interaction.value, ...timeout];
    }
    case 'ax_select': {
      const ref = refArgs(interaction);
      if ('error' in ref) return ref;
      if (!interaction.value) return { error: 'ax_select requires action.value' };
      return ['select', ...ref, interaction.value, ...timeout];
    }
    default:
      return { error: `Unsupported ax interaction: ${interaction.type}` };
  }
}

/**
 * Ops whose intent can be checked with a cheap postcondition readback
 * (`get`/`is` against the same qualified ref). `ax_toggle` is deliberately
 * absent — its intent is "invert", unverifiable without a before-state.
 */
const AX_VERIFY_READS: Record<
  string,
  { command: 'get' | 'is'; property: string; expected: (i: AxInteraction) => string | boolean }
> = {
  ax_set_value: { command: 'get', property: 'value', expected: (i) => i.value ?? '' },
  ax_clear: { command: 'get', property: 'value', expected: () => '' },
  ax_check: { command: 'is', property: 'checked', expected: () => true },
  ax_uncheck: { command: 'is', property: 'checked', expected: () => false },
  ax_expand: { command: 'is', property: 'expanded', expected: () => true },
  ax_collapse: { command: 'is', property: 'expanded', expected: () => false },
  ax_focus: { command: 'is', property: 'focused', expected: () => true },
  ax_scroll_to: { command: 'is', property: 'visible', expected: () => true },
};

const DELIVERIES: ReadonlySet<string> = new Set([
  'unknown',
  'not_delivered',
  'delivery_uncertain',
  'delivered_unverified',
  'delivered_verified',
]);

function envelopeDisposition(
  disposition: { delivery?: string; retry?: string } | undefined,
  fallback: ComputerInteractionDelivery
) {
  const delivery = DELIVERIES.has(disposition?.delivery ?? '')
    ? (disposition?.delivery as ComputerInteractionDelivery)
    : fallback;
  return dispositionFor(delivery);
}

/** Observation fields each op is expected to report on the tool result. */
const AX_EVIDENCE_FIELDS: Record<string, string[]> = {
  ax_snapshot: ['snapshot_id', 'tree', 'ref_count', 'complete'],
  ax_find: ['matches'],
  ax_list_windows: ['windows'],
  ax_list_apps: ['apps'],
  ax_list_displays: ['displays'],
  ax_list_surfaces: ['surfaces'],
  ax_list_notifications: ['notifications'],
};

/**
 * Tri-state per-field read status (`tool_result.evidence`): `known` when a
 * value was read, `absent` when the field provably does not exist (null or
 * `applicable:false`), `unknown` when the read itself failed. Only ax_get /
 * ax_is have a single-field semantic; collection ops mark their payload keys.
 */
function buildAxEvidence(
  interaction: AxInteraction,
  result: AgentDesktopResult
): Record<string, 'known' | 'absent' | 'unknown'> | undefined {
  if (!AX_OBSERVATION_OPS.has(interaction.type)) return undefined;
  if (interaction.type === 'ax_get' || interaction.type === 'ax_is') {
    const property = interaction.property ?? (interaction.type === 'ax_get' ? 'text' : 'visible');
    if (!result.ok || !result.envelope?.data || typeof result.envelope.data !== 'object') {
      return { [property]: 'unknown' };
    }
    const data = result.envelope.data as Record<string, unknown>;
    if (interaction.type === 'ax_is' && data.applicable === false) {
      return { [property]: 'absent' };
    }
    const value = interaction.type === 'ax_is' ? data.result : data.value;
    return { [property]: value === undefined || value === null ? 'absent' : 'known' };
  }
  const fields = AX_EVIDENCE_FIELDS[interaction.type];
  if (!fields) return undefined;
  const data =
    result.ok && result.envelope?.data && typeof result.envelope.data === 'object'
      ? (result.envelope.data as Record<string, unknown>)
      : undefined;
  const evidence: Record<string, 'known' | 'absent' | 'unknown'> = {};
  for (const field of fields) {
    evidence[field] = !data
      ? 'unknown'
      : data[field] === undefined || data[field] === null
        ? 'absent'
        : 'known';
  }
  return evidence;
}

function mapResult(interaction: AxInteraction, result: AgentDesktopResult) {
  if (result.ok) {
    const mutating = AX_MUTATING_OPS.has(interaction.type);
    const outcome = mutating
      ? stampOutcome(
          {},
          {
            code: 'OK',
            disposition: envelopeDisposition(result.envelope.disposition, 'delivered_unverified'),
          }
        )
      : {};
    const data =
      result.envelope.data && typeof result.envelope.data === 'object'
        ? (result.envelope.data as Record<string, unknown>)
        : undefined;
    return {
      status: 'succeeded',
      results: [{ op: interaction.type, status: 'succeeded' }],
      ...outcome,
      // Surface upstream completeness flags at the contract level.
      ...(typeof data?.complete === 'boolean' ? { complete: data.complete } : {}),
      ...(typeof data?.truncated === 'boolean' ? { truncated: data.truncated } : {}),
      ...(buildAxEvidence(interaction, result)
        ? { evidence: buildAxEvidence(interaction, result) }
        : {}),
      context: result.envelope.data !== undefined ? { data: result.envelope.data } : {},
      total_steps: 1,
    };
  }
  // Codes where the command was refused before dispatch — delivery provably
  // did not happen. Everything else stays `unknown` (never guessed).
  const NOT_DELIVERED_CODES = new Set([
    'TOOL_UNAVAILABLE',
    'STALE_REF',
    'SNAPSHOT_NOT_FOUND',
    'COMMAND_NOT_ALLOWED',
    'POLICY_DENIED',
    'ACTION_NOT_SUPPORTED',
    'AMBIGUOUS_TARGET',
    'INVALID_ARGS',
    'SESSION_NOT_FOUND',
    'SESSION_UNAVAILABLE',
    'SESSION_END_FAILED',
    'SESSION_GC_FAILED',
  ]);
  // Refused for a reason an identical retry cannot fix — callers must not
  // machine-retry these even though delivery classification is honest.
  const NON_RETRYABLE_CODES = new Set([
    'TOOL_UNAVAILABLE',
    'POLICY_DENIED',
    'INVALID_ARGS',
    'COMMAND_NOT_ALLOWED',
    'ACTION_NOT_SUPPORTED',
  ]);
  // strict:false — `ok` narrowing is unavailable; take the error variant.
  const error = result as Extract<AgentDesktopResult, { ok: false }>;
  const notDelivered = NOT_DELIVERED_CODES.has(error.code);
  const strategy =
    error.code === 'TOOL_UNAVAILABLE'
      ? 'install_tool_runtime'
      : error.code === 'POLICY_DENIED'
        ? 'use_physical_channel'
        : ['STALE_REF', 'SNAPSHOT_NOT_FOUND', 'AMBIGUOUS_TARGET'].includes(error.code)
          ? 're_observe_then_retry'
          : undefined;
  const stamped = stampOutcome(
    {},
    {
      code: error.code,
      disposition: envelopeDisposition(
        error.disposition,
        notDelivered ? 'not_delivered' : 'unknown'
      ),
      recovery: {
        strategy,
        retryable: notDelivered && !NON_RETRYABLE_CODES.has(error.code),
        requires_fresh_observation:
          error.code === 'STALE_REF' ||
          error.code === 'SNAPSHOT_NOT_FOUND' ||
          error.code === 'AMBIGUOUS_TARGET',
      },
    }
  );
  return {
    status: 'failed',
    results: [{ op: interaction.type, status: 'failed' }],
    ...stamped,
    ...(buildAxEvidence(interaction, result)
      ? { evidence: buildAxEvidence(interaction, result) }
      : {}),
    context: { detail: error.message },
    total_steps: 1,
  };
}

/**
 * Postcondition readback for mutating ax ops: re-read the element's live
 * property via `get`/`is` and compare to the intended state. Returns null
 * when the op has no honest readback or the read itself fails — an
 * unavailable read is never reported as verified or contradicted.
 */
function verifyAxPostcondition(
  interaction: AxInteraction,
  ctx: AxHandlerContext
): { kind: string; expected: unknown; observed: unknown; matched: boolean | null } | null {
  const verify = AX_VERIFY_READS[interaction.type];
  if (!verify || !interaction.qualified_ref) return null;
  const expected = verify.expected(interaction);
  const read = runAgentDesktopCommand(
    [verify.command, interaction.qualified_ref, '--property', verify.property],
    { sessionId: ctx.sessionId, timeoutMs: 15_000 }
  );
  if (!read.ok || !read.envelope.data || typeof read.envelope.data !== 'object') return null;
  // `get` returns {property, ref, value}; `is` returns {property, ref, result, applicable}.
  const data = read.envelope.data as Record<string, unknown>;
  const observed = verify.command === 'is' ? data.result : data.value;
  if (observed === undefined) return null;
  const matched =
    typeof expected === 'string'
      ? String(observed) === expected
      : observed === true || observed === 'true'
        ? expected === true
        : observed === false || observed === 'false'
          ? expected === false
          : null;
  return {
    kind: `ax_${verify.command}_${verify.property}`,
    expected,
    observed,
    matched,
  };
}

function approvalBlocked(interaction: AxInteraction, ctx: AxHandlerContext, requestId?: string) {
  ctx.emitPatch('blocked', interaction.type, 'approval required', interaction.qualified_ref, {
    approvalRequired: true,
  });
  return {
    status: 'blocked',
    results: [{ op: interaction.type, status: 'blocked' }],
    context: {
      approval_required: true,
      approval_request_id: requestId,
      approval_channel: 'computer',
    },
    total_steps: 1,
  };
}

async function ensureAxApproval(
  interaction: AxInteraction,
  ctx: AxHandlerContext
): Promise<ReturnType<typeof approvalBlocked> | null> {
  const requestId = interaction.approval_request_id;
  if (!requestId) {
    const request = createApprovalRequest('sovereign_concierge', {
      channel: 'computer',
      storageChannel: 'computer',
      threadTs: ctx.sessionId || 'computer',
      correlationId: randomUUID(),
      requestedBy: 'system-actuator',
      kind: 'channel-approval',
      draft: {
        title: `Approval required: ${interaction.type}`,
        summary:
          'A computer interaction requested an agent-desktop accessibility action that mutates application state.',
        details: `Approve this request before running ${interaction.type} on ${interaction.qualified_ref ?? 'target'}.`,
        severity: 'medium',
      },
      requestedByContext: {
        surface: 'system',
        actorId: 'system-actuator',
        actorRole: 'sovereign_concierge',
        runtimeId: ctx.sessionId,
      },
      justification: {
        reason:
          'agent-desktop AX action mutates application state through the accessibility interface.',
        impactSummary: `${interaction.type} on ${interaction.qualified_ref ?? 'target'}`,
        requestedEffects: [interaction.type],
      },
      risk: {
        level: 'medium',
        restartScope: 'none',
        requiresStrongAuth: false,
        policyId: 'wf_computer_destructive_v1',
      },
      workflow: {
        workflowId: 'wf_computer_destructive_v1',
        mode: 'all_required',
        requiredRoles: ['sovereign'],
        currentStage: 'review',
        stages: [
          {
            stageId: 'review',
            requiredRoles: ['sovereign'],
            description: 'Approve agent-desktop AX action',
          },
        ],
        approvals: [{ role: 'sovereign', status: 'pending' }],
      },
    });
    return approvalBlocked(interaction, ctx, request.id);
  }
  const request = loadApprovalRequest('computer', requestId);
  if (
    !request ||
    (request.status !== 'approved' && request.status !== 'applied') ||
    approvalUsabilityRefusal(request, 'system_actuator_computer')
  ) {
    return approvalBlocked(interaction, ctx, requestId);
  }
  return null;
}

/**
 * Execute an `ax_*` computer_interaction through the managed agent-desktop
 * runtime. Returns a computer_interaction-shaped result (status/results/
 * context) — never throws for absent runtime, ref failures, or envelope
 * errors; those arrive as structured codes in `context`.
 */
export async function handleAxInteraction(
  interaction: AxInteraction,
  ctx: AxHandlerContext
): Promise<Record<string, unknown>> {
  const availability = agentDesktopAvailability();
  // Preflight probe — always answers, even (especially) when the runtime is
  // absent, so callers can discover the backend before dispatching real ops.
  if (interaction.type === 'ax_runtime_status') {
    ctx.emitPatch(
      'succeeded',
      interaction.type,
      availability.available ? 'agent-desktop runtime ready' : 'agent-desktop runtime unavailable'
    );
    return {
      status: 'succeeded',
      results: [{ op: 'ax_runtime_status', status: 'succeeded' }],
      evidence: {
        available: 'known',
        bin: availability.bin ? 'known' : 'absent',
        version: availability.version ? 'known' : 'absent',
        detail: availability.detail ? 'known' : 'absent',
      },
      context: {
        data: { ...availability },
        ...(availability.available
          ? {}
          : { install: 'pnpm tool:setup -- --tool agent_desktop --apply' }),
      },
      total_steps: 1,
    };
  }
  if (!availability.available) {
    ctx.emitPatch('failed', interaction.type, 'agent-desktop unavailable');
    return unavailableResult(interaction, availability.detail);
  }
  if (AX_LIFECYCLE_OPS.has(interaction.type)) {
    const lifecycle =
      interaction.type === 'ax_session_gc'
        ? gcAgentDesktopSessions()
        : endAgentDesktopSession(interaction.task_session_id ?? ctx.sessionId);
    const ok = lifecycle.ok;
    const lifecycleError = ok
      ? undefined
      : (lifecycle as Extract<AgentDesktopResult, { ok: false }>);
    ctx.emitPatch(ok ? 'succeeded' : 'failed', interaction.type, lifecycleError?.message);
    return {
      status: ok ? 'succeeded' : 'failed',
      results: [{ op: interaction.type, status: ok ? 'succeeded' : 'failed' }],
      ...(lifecycleError ? { code: lifecycleError.code } : {}),
      context: { detail: lifecycleError?.message },
      total_steps: 1,
    };
  }
  const args = buildArgs(interaction, ctx.application);
  if ('error' in args) {
    ctx.emitPatch('failed', interaction.type, args.error);
    const stamped = stampOutcome(
      {},
      {
        code: 'INVALID_ARGS',
        disposition: dispositionFor('not_delivered'),
        recovery: { strategy: 'fix_arguments_then_retry', retryable: false },
      }
    );
    return {
      status: 'failed',
      results: [{ op: interaction.type, status: 'failed' }],
      ...stamped,
      context: { detail: args.error },
      total_steps: 1,
    };
  }
  if (AX_COMMIT_OPS.has(interaction.type)) {
    const blocked = await ensureAxApproval(interaction, ctx);
    if (blocked) return blocked;
  }
  const result = runAgentDesktopCommand(args, {
    sessionId: ctx.sessionId,
    // Inventory commands carry no session-scoped state; skip the bootstrap.
    requireSession: !AX_SESSION_INDEPENDENT_OPS.has(interaction.type),
    timeoutMs: (interaction.timeout_ms ?? AX_DEFAULT_TIMEOUT_MS) + 15_000,
  });
  const mapped = mapResult(interaction, result);
  if (result.ok && AX_MUTATING_OPS.has(interaction.type)) {
    const verification = verifyAxPostcondition(interaction, ctx);
    if (verification) {
      (mapped.context as Record<string, unknown>).verification = verification;
      (mapped as Record<string, unknown>).disposition = dispositionFor(
        verification.matched === true
          ? 'delivered_verified'
          : verification.matched === false
            ? 'delivery_uncertain'
            : 'delivered_unverified'
      );
    }
  }
  ctx.emitPatch(
    mapped.status === 'succeeded' ? 'succeeded' : 'failed',
    interaction.type,
    result.ok ? undefined : (result as Extract<AgentDesktopResult, { ok: false }>).message,
    interaction.qualified_ref
  );
  return mapped;
}
