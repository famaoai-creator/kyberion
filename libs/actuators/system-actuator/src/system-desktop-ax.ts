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
/** Upstream --agent-id constraint: 1-64 letters/digits/dash/underscore. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Surfaces `open-system-surface` accepts upstream (shell + AX surfaces). */
const SYSTEM_SURFACES = new Set([
  'window',
  'focused',
  'menu',
  'menubar',
  'sheet',
  'popover',
  'alert',
  'desktop',
  'taskbar',
  'system-tray',
  'quick-settings',
  'notification-center',
  'toolbar',
  'dock',
  'spotlight',
  'menu-bar-extras',
  'system-tray-overflow',
  'start-menu',
  'action-center',
]);
/** Desktop lifecycle signals `wait --event` accepts upstream. */
const WAIT_EVENTS = new Set([
  'window-opened',
  'window-closed',
  'app-launched',
  'app-terminated',
  'focus-changed',
  'surface-appeared',
  'surface-dismissed',
]);
const WAIT_PREDICATES = new Set(['exists', 'enabled', 'visible', 'actionable', 'value']);
const CLIPBOARD_FORMATS = new Set(['text', 'auto', 'image', 'file-urls']);

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
  'ax_wait',
  'ax_permissions',
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
  'ax_focus_window',
  'ax_move_window',
  'ax_resize_window',
  'ax_minimize_window',
  'ax_maximize_window',
  'ax_restore_window',
  'ax_open_system_surface',
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
  'ax_launch',
  'ax_close_app',
  'ax_dismiss_notification',
  'ax_dismiss_all_notifications',
  'ax_notification_action',
  'ax_clipboard_get',
  'ax_clipboard_set',
  'ax_clipboard_clear',
]);
export const AX_MUTATING_OPS = new Set([...AX_NAV_OPS, ...AX_COMMIT_OPS]);
/** Observation commands that carry no session-scoped state. */
const AX_SESSION_INDEPENDENT_OPS = new Set([
  'ax_list_windows',
  'ax_list_apps',
  'ax_list_displays',
  'ax_list_surfaces',
  'ax_list_notifications',
  'ax_permissions',
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
  agent_id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  ms?: number;
  event?: string;
  predicate?: string;
  action?: string;
  count?: number;
  menu?: boolean;
  menu_closed?: boolean;
  notification?: boolean;
  index?: number;
  expected_app?: string;
  expected_title?: string;
  format?: string;
  image?: string;
  file_urls?: string[];
  force?: boolean;
  activate?: boolean;
  cdp?: boolean | number;
  no_attach?: boolean;
  app_args?: string[];
  app_env?: Record<string, string>;
  cwd?: string;
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
  // --timeout-ms exists only on snapshot/find/list-windows/list-apps/ref
  // actions; window/lifecycle/notification/clipboard commands take no
  // deadline flag (launch and wait use --timeout). Verified against the
  // upstream --help surface.
  if (interaction.agent_id !== undefined && !AGENT_ID.test(interaction.agent_id)) {
    return { error: 'agent_id must match /^[A-Za-z0-9_-]{1,64}$/ (upstream --agent-id)' };
  }
  const appScope = (allowTitle = false): string[] => {
    const args = scopeArgs(interaction, application);
    if (allowTitle && interaction.title) args.push('--title', interaction.title);
    return args;
  };
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
    case 'ax_focus_window':
      return ['focus-window', ...appScope(true)];
    case 'ax_minimize_window':
      return ['minimize', ...appScope()];
    case 'ax_maximize_window':
      return ['maximize', ...appScope()];
    case 'ax_restore_window':
      return ['restore', ...appScope()];
    case 'ax_move_window': {
      if (typeof interaction.x !== 'number' || typeof interaction.y !== 'number') {
        return { error: 'ax_move_window requires numeric action.x and action.y' };
      }
      // --x=N form is required for negative values upstream.
      return ['move-window', `--x=${interaction.x}`, `--y=${interaction.y}`, ...appScope()];
    }
    case 'ax_resize_window': {
      if (typeof interaction.width !== 'number' || typeof interaction.height !== 'number') {
        return { error: 'ax_resize_window requires numeric action.width and action.height' };
      }
      if (interaction.width <= 0 || interaction.height <= 0) {
        return { error: 'ax_resize_window width/height must be positive' };
      }
      return [
        'resize-window',
        `--width=${interaction.width}`,
        `--height=${interaction.height}`,
        ...appScope(),
      ];
    }
    case 'ax_open_system_surface': {
      if (!interaction.surface || !SYSTEM_SURFACES.has(interaction.surface)) {
        return {
          error: `ax_open_system_surface requires action.surface in ${[...SYSTEM_SURFACES].join('|')}`,
        };
      }
      return ['open-system-surface', '--surface', interaction.surface];
    }
    case 'ax_permissions':
      return ['permissions'];
    case 'ax_wait': {
      const args = ['wait'];
      const conditionFlags: string[] = [];
      if (typeof interaction.ms === 'number') args.push(String(interaction.ms));
      if (interaction.qualified_ref) {
        if (!QUALIFIED_REF.test(interaction.qualified_ref)) {
          return { error: 'ax_wait element wait requires a snapshot-qualified ref' };
        }
        conditionFlags.push('--element', interaction.qualified_ref);
      }
      if (interaction.title) conditionFlags.push('--window', interaction.title);
      if (interaction.text) conditionFlags.push('--text', interaction.text);
      if (interaction.menu) conditionFlags.push('--menu');
      if (interaction.menu_closed) conditionFlags.push('--menu-closed');
      if (interaction.notification) conditionFlags.push('--notification');
      if (interaction.event) {
        if (!WAIT_EVENTS.has(interaction.event)) {
          return {
            error: `ax_wait event must be one of ${[...WAIT_EVENTS].join('|')}`,
          };
        }
        conditionFlags.push('--event', interaction.event);
      }
      if (interaction.predicate) {
        if (!WAIT_PREDICATES.has(interaction.predicate)) {
          return {
            error: `ax_wait predicate must be one of ${[...WAIT_PREDICATES].join('|')}`,
          };
        }
        conditionFlags.push('--predicate', interaction.predicate);
      }
      if (interaction.value !== undefined) conditionFlags.push('--value', interaction.value);
      if (interaction.action) conditionFlags.push('--action', interaction.action);
      if (typeof interaction.count === 'number') {
        conditionFlags.push('--count', String(interaction.count));
      }
      if (conditionFlags.length === 0 && typeof interaction.ms !== 'number') {
        return {
          error:
            'ax_wait requires a condition: ms, qualified_ref (element), title (window), ' +
            'text, menu, menu_closed, notification, or event',
        };
      }
      args.push(...conditionFlags);
      if (interaction.application || application) {
        args.push('--app', interaction.application ?? application ?? '');
      }
      if (interaction.window_id) args.push('--window-id', interaction.window_id);
      args.push('--timeout', String(interaction.timeout_ms ?? AX_DEFAULT_TIMEOUT_MS));
      return args;
    }
    case 'ax_launch': {
      const app = interaction.application ?? application;
      if (!app) return { error: 'ax_launch requires action.application' };
      const args = ['launch', app];
      args.push('--timeout', String(interaction.timeout_ms ?? AX_DEFAULT_TIMEOUT_MS));
      for (const arg of interaction.app_args ?? []) args.push(`--arg=${arg}`);
      for (const [key, value] of Object.entries(interaction.app_env ?? {})) {
        args.push('--env', `${key}=${value}`);
      }
      if (interaction.cwd) args.push('--cwd', interaction.cwd);
      if (interaction.activate) args.push('--activate');
      if (interaction.no_attach) args.push('--no-attach');
      if (interaction.cdp === true) args.push('--cdp');
      else if (typeof interaction.cdp === 'number') args.push(`--cdp=${interaction.cdp}`);
      return args;
    }
    case 'ax_close_app': {
      const app = interaction.application ?? application;
      if (!app) return { error: 'ax_close_app requires action.application' };
      const args = ['close-app', app];
      if (interaction.force) args.push('--force');
      return args;
    }
    case 'ax_dismiss_notification': {
      if (!Number.isInteger(interaction.index) || (interaction.index ?? 0) < 1) {
        return { error: 'ax_dismiss_notification requires integer action.index >= 1' };
      }
      // Upstream refuses an unverified positional dismiss: one identity
      // field (--app counts) must pin which notification index N is.
      const args = ['dismiss-notification', String(interaction.index)];
      if (interaction.application || application) {
        args.push('--app', interaction.application ?? application ?? '');
      }
      if (interaction.expected_app) args.push('--expected-app', interaction.expected_app);
      if (interaction.expected_title) {
        args.push('--expected-title', interaction.expected_title);
      }
      if (args.length === 2) {
        return {
          error:
            'ax_dismiss_notification requires an identity check: application, ' +
            'expected_app, or expected_title',
        };
      }
      return args;
    }
    case 'ax_dismiss_all_notifications': {
      const args = ['dismiss-all-notifications'];
      if (interaction.application || application) {
        args.push('--app', interaction.application ?? application ?? '');
      }
      return args;
    }
    case 'ax_notification_action': {
      if (!Number.isInteger(interaction.index) || (interaction.index ?? 0) < 1) {
        return { error: 'ax_notification_action requires integer action.index >= 1' };
      }
      if (!interaction.action) {
        return { error: 'ax_notification_action requires action.action (button name)' };
      }
      const args = ['notification-action', String(interaction.index), interaction.action];
      if (interaction.expected_app) args.push('--expected-app', interaction.expected_app);
      if (interaction.expected_title) {
        args.push('--expected-title', interaction.expected_title);
      }
      if (!interaction.expected_app && !interaction.expected_title) {
        return {
          error:
            'ax_notification_action requires an identity check: expected_app or expected_title',
        };
      }
      return args;
    }
    case 'ax_clipboard_get': {
      const args = ['clipboard-get'];
      if (interaction.format) {
        if (!CLIPBOARD_FORMATS.has(interaction.format)) {
          return {
            error: `ax_clipboard_get format must be one of ${[...CLIPBOARD_FORMATS].join('|')}`,
          };
        }
        args.push('--format', interaction.format);
      }
      // --out deliberately unexposed: upstream writes image payloads to a
      // private temp under the governed session dir by default.
      return args;
    }
    case 'ax_clipboard_set': {
      const args = ['clipboard-set'];
      let payload = 0;
      if (typeof interaction.text === 'string') {
        args.push(interaction.text);
        payload += 1;
      }
      if (interaction.image) {
        args.push('--image', interaction.image);
        payload += 1;
      }
      for (const fileUrl of interaction.file_urls ?? []) {
        args.push('--file-url', fileUrl);
        payload += 1;
      }
      if (payload === 0) {
        return {
          error: 'ax_clipboard_set requires a payload: text, image, or file_urls',
        };
      }
      return args;
    }
    case 'ax_clipboard_clear':
      return ['clipboard-clear'];
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
  ax_wait: ['waited_ms'],
  ax_permissions: ['accessibility', 'automation', 'screen_recording'],
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
  const hasData = result.ok && result.envelope?.data != null;
  const data =
    hasData && typeof result.envelope?.data === 'object'
      ? (result.envelope.data as Record<string, unknown>)
      : undefined;
  const evidence: Record<string, 'known' | 'absent' | 'unknown'> = {};
  for (const field of fields) {
    // Upstream returns some collections as a bare array payload
    // (list-windows, list-displays) — the array itself is the field.
    evidence[field] = !hasData
      ? 'unknown'
      : Array.isArray(data)
        ? 'known'
        : data?.[field] === undefined || data?.[field] === null
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
    'WINDOW_NOT_FOUND',
    'APP_NOT_FOUND',
    'NOTIFICATION_NOT_FOUND',
    'PERM_DENIED',
  ]);
  // Refused for a reason an identical retry cannot fix — callers must not
  // machine-retry these even though delivery classification is honest.
  const NON_RETRYABLE_CODES = new Set([
    'TOOL_UNAVAILABLE',
    'POLICY_DENIED',
    'INVALID_ARGS',
    'COMMAND_NOT_ALLOWED',
    'ACTION_NOT_SUPPORTED',
    'PERM_DENIED',
  ]);
  // strict:false — `ok` narrowing is unavailable; take the error variant.
  const error = result as Extract<AgentDesktopResult, { ok: false }>;
  const notDelivered = NOT_DELIVERED_CODES.has(error.code);
  // Upstream attaches its own recovery contract (strategy/retryable/
  // requires_fresh_snapshot) to many errors — surface it when present and
  // fall back to the local classification table otherwise.
  const upstreamRecovery = error.envelope?.error?.recovery;
  const strategy =
    upstreamRecovery?.strategy ??
    (error.code === 'TOOL_UNAVAILABLE'
      ? 'install_tool_runtime'
      : error.code === 'POLICY_DENIED'
        ? 'use_physical_channel'
        : error.code === 'PERM_DENIED'
          ? 'grant_permissions'
          : [
                'STALE_REF',
                'SNAPSHOT_NOT_FOUND',
                'AMBIGUOUS_TARGET',
                'WINDOW_NOT_FOUND',
                'APP_NOT_FOUND',
                'NOTIFICATION_NOT_FOUND',
              ].includes(error.code)
            ? 're_observe_then_retry'
            : undefined);
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
        // Precedence: upstream error.recovery.retryable > upstream
        // disposition.retry (safe/unsafe) > the local refusal table.
        retryable:
          upstreamRecovery?.retryable ??
          (error.disposition?.retry === 'safe'
            ? true
            : error.disposition?.retry === 'unsafe'
              ? false
              : notDelivered && !NON_RETRYABLE_CODES.has(error.code)),
        requires_fresh_observation:
          upstreamRecovery?.requires_fresh_snapshot ??
          (error.code === 'STALE_REF' ||
            error.code === 'SNAPSHOT_NOT_FOUND' ||
            error.code === 'AMBIGUOUS_TARGET'),
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

/**
 * Approval narrative per commit-class op family — clipboard reads are
 * sensitive reads (secrets may be present), not mutations, and app/notification
 * lifecycle ops change more than element state.
 */
function approvalNarrative(interaction: AxInteraction): {
  summary: string;
  reason: string;
  target: string;
} {
  const target = interaction.qualified_ref ?? interaction.application ?? 'target';
  if (interaction.type === 'ax_clipboard_get') {
    return {
      summary:
        'A computer interaction requested reading the system clipboard, which may contain secrets or personal data.',
      reason: 'agent-desktop clipboard reads expose paste-buffer contents to the agent.',
      target: 'system clipboard',
    };
  }
  if (interaction.type === 'ax_clipboard_set' || interaction.type === 'ax_clipboard_clear') {
    return {
      summary:
        'A computer interaction requested overwriting the system clipboard, destroying its current contents.',
      reason: 'agent-desktop clipboard writes destructively replace paste-buffer contents.',
      target: 'system clipboard',
    };
  }
  if (interaction.type === 'ax_launch' || interaction.type === 'ax_close_app') {
    return {
      summary: `A computer interaction requested ${interaction.type === 'ax_launch' ? 'launching' : 'quitting'} an application via the desktop runtime.`,
      reason: 'agent-desktop app lifecycle commands start or terminate OS processes.',
      target,
    };
  }
  if (
    interaction.type === 'ax_dismiss_notification' ||
    interaction.type === 'ax_dismiss_all_notifications' ||
    interaction.type === 'ax_notification_action'
  ) {
    return {
      summary:
        'A computer interaction requested dismissing or acting on a user notification, which cannot be undone.',
      reason: 'agent-desktop notification commands consume user-facing notifications.',
      target,
    };
  }
  return {
    summary:
      'A computer interaction requested an agent-desktop accessibility action that mutates application state.',
    reason:
      'agent-desktop AX action mutates application state through the accessibility interface.',
    target,
  };
}

async function ensureAxApproval(
  interaction: AxInteraction,
  ctx: AxHandlerContext
): Promise<ReturnType<typeof approvalBlocked> | null> {
  const requestId = interaction.approval_request_id;
  if (!requestId) {
    const narrative = approvalNarrative(interaction);
    const request = createApprovalRequest('sovereign_concierge', {
      channel: 'computer',
      storageChannel: 'computer',
      threadTs: ctx.sessionId || 'computer',
      correlationId: randomUUID(),
      requestedBy: 'system-actuator',
      kind: 'channel-approval',
      draft: {
        title: `Approval required: ${interaction.type}`,
        summary: narrative.summary,
        details: `Approve this request before running ${interaction.type} on ${narrative.target}.`,
        severity: 'medium',
      },
      requestedByContext: {
        surface: 'system',
        actorId: 'system-actuator',
        actorRole: 'sovereign_concierge',
        runtimeId: ctx.sessionId,
      },
      justification: {
        reason: narrative.reason,
        impactSummary: `${interaction.type} on ${narrative.target}`,
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
    agentId: interaction.agent_id,
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
