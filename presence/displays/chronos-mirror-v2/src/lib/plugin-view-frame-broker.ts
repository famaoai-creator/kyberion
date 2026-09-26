/**
 * PH-02: host side of the `postMessage` channel of a sandboxed-iframe plugin
 * view. Pure (no DOM, no fetch): the component injects the frame window, the
 * clock, the confirm dialog and the POST.
 *
 * A message is handled only when
 *   - it comes from this view's frame window (`event.source`; the sandboxed
 *     frame's origin is the opaque "null", so origin is useless),
 *   - it is plain data (no class instances, Blobs, cycles) of at most 16 KB,
 *   - it matches the protocol shape exactly (unknown keys are dropped).
 * `action.request` additionally needs the `action.request` capability and an
 * action the view declares; one request may be in flight and at most 10 are
 * accepted per minute. Every accepted request goes through the host confirm
 * dialog (plugin, action, params) before the existing plugin-views POST — a
 * `human` action there only becomes an approval request. `resize` heights
 * are clamped to 120–2000 px. Replies carry codes only.
 *
 * `event.source` survives a navigation of the frame, and a sandboxed frame may
 * still navigate itself. The component reports every iframe `load` through
 * `frameLoaded()`: the first is the approved document, any later one is a
 * navigation and invalidates the broker for good — every later message is
 * dropped and no pending result is posted back. The Chronos pages' CSP
 * (`frame-src 'self'`) keeps such a navigation same-origin; a new broker is
 * only created for a freshly mounted frame (the user reopens the view).
 *
 * Residual pre-load window: a navigation is only seen at the new document's
 * `load`, so scripts of the navigated document can post (same `event.source`)
 * before it fires. That window is bounded by `frame-src 'self'` (only
 * same-origin documents, i.e. other served plugin views, can load there), by
 * the opened view's declared actions and capabilities, and by the host
 * confirm dialog every action request passes. A per-load channel nonce sent
 * in `init` would not close it: the navigated document can send `ready` and
 * receive a fresh `init` as well.
 */
import {
  PLUGIN_VIEW_ACTION_REQUEST_CAPABILITY,
  PLUGIN_VIEW_FRAME_PROTOCOL,
} from '@agent/core/plugin-view-frame';

export const PLUGIN_VIEW_FRAME_MAX_MESSAGE_BYTES = 16 * 1024;
export const PLUGIN_VIEW_FRAME_MAX_REQUESTS_PER_MINUTE = 10;
export const PLUGIN_VIEW_FRAME_MIN_HEIGHT = 120;
export const PLUGIN_VIEW_FRAME_MAX_HEIGHT = 2000;
const RATE_WINDOW_MS = 60_000;
const MAX_DEPTH = 16;
const MAX_NODES = 2048;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const ACTION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

const MESSAGE_KEYS: Record<string, readonly string[]> = {
  ready: ['protocol', 'type'],
  resize: ['protocol', 'type', 'height'],
  'action.request': ['protocol', 'type', 'requestId', 'actionId', 'params'],
};

export type PluginViewFrameDropReason =
  | 'invalidated'
  | 'source'
  | 'not_plain_data'
  | 'oversize'
  | 'shape'
  | 'capability'
  | 'undeclared_action';

export type PluginViewFrameRejectCode = 'PLUGIN_VIEW_FRAME_BUSY' | 'PLUGIN_VIEW_FRAME_RATE_LIMITED';

export interface PluginViewFrameActionRequest {
  pluginId: string;
  viewId: string;
  actionId: string;
  params: Record<string, unknown>;
}

export interface PluginViewFrameActionResult {
  /** `approval_required` | `dispatched` | `executed` | `declined` | `rejected` | `error`. */
  status: string;
  errorCode?: string;
}

export interface PluginViewFrameReply {
  protocol: typeof PLUGIN_VIEW_FRAME_PROTOCOL;
  type: 'init' | 'action.result';
  locale?: string;
  requestId?: string;
  status?: string;
  errorCode?: string;
}

export interface PluginViewFrameBrokerOptions {
  pluginId: string;
  viewId: string;
  capabilities: readonly string[];
  actions: ReadonlyArray<{ id: string }>;
  locale: string;
  /** The frame's current `contentWindow` (null before load). */
  frameWindow: () => unknown;
  /** Posts a reply to the frame window. */
  post: (message: PluginViewFrameReply) => void;
  /** Host confirm dialog; resolves true only on an explicit allow. */
  confirm: (request: PluginViewFrameActionRequest) => Promise<boolean>;
  /** The existing plugin-views POST. */
  submit: (request: PluginViewFrameActionRequest) => Promise<PluginViewFrameActionResult>;
  onResize?: (height: number) => void;
  now?: () => number;
}

export type PluginViewFrameHandleResult =
  | { handled: false; reason: PluginViewFrameDropReason }
  | { handled: true; kind: 'ready' | 'resize' }
  | {
      handled: true;
      kind: 'action.request';
      rejected?: PluginViewFrameRejectCode;
      done?: Promise<void>;
    };

export interface PluginViewFrameBroker {
  handleMessage(event: { source: unknown; data: unknown }): PluginViewFrameHandleResult;
  /**
   * Call on every iframe `load`. The first load is the approved document;
   * a later one is a navigation: the broker invalidates itself and returns false.
   */
  frameLoaded(): boolean;
  /** Stops the broker for good: later messages are dropped, pending results are not posted. */
  invalidate(): void;
  readonly invalidated: boolean;
  /** Locale change: re-sends `init` once the frame is ready (keeps the rate limit). */
  setLocale(locale: string): void;
}

type FrameDataVerdict = 'ok' | 'not_plain_data' | 'oversize';

/**
 * Walks JSON-like data built from plain objects and arrays (bounded depth and
 * nodes). String and key lengths are summed on the way: UTF-8 is at least one
 * byte per UTF-16 unit, so a sum above the message bound is oversize before
 * anything is serialized.
 */
function inspectFrameData(value: unknown): FrameDataVerdict {
  let nodes = 0;
  let chars = 0;
  let oversize = false;
  const seen = new Set<object>();
  const count = (text: string): boolean => {
    chars += text.length;
    if (chars > PLUGIN_VIEW_FRAME_MAX_MESSAGE_BYTES) oversize = true;
    return !oversize;
  };
  const visit = (current: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) return false;
    if (current === null) return true;
    switch (typeof current) {
      case 'string':
        return count(current);
      case 'boolean':
        return true;
      case 'number':
        return Number.isFinite(current);
      case 'object':
        break;
      default:
        return false;
    }
    const object = current as object;
    if (seen.has(object)) return false;
    seen.add(object);
    if (Array.isArray(object)) return object.every((item) => visit(item, depth + 1));
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.entries(object).every(([key, item]) => count(key) && visit(item, depth + 1));
  };
  if (visit(value, 0)) return 'ok';
  return oversize ? 'oversize' : 'not_plain_data';
}

/** Accepts only JSON-like data built from plain objects and arrays (bounded). */
export function isPlainFrameData(value: unknown): boolean {
  return inspectFrameData(value) === 'ok';
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function clampPluginViewFrameHeight(height: number): number {
  return Math.min(
    PLUGIN_VIEW_FRAME_MAX_HEIGHT,
    Math.max(PLUGIN_VIEW_FRAME_MIN_HEIGHT, Math.round(height))
  );
}

function hasExactKeys(data: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(data).every((key) => allowed.includes(key));
}

export function createPluginViewFrameBroker(
  options: PluginViewFrameBrokerOptions
): PluginViewFrameBroker {
  const now = options.now ?? (() => Date.now());
  const declared = new Set(options.actions.map((action) => action.id));
  const mayRequest =
    options.capabilities.includes(PLUGIN_VIEW_ACTION_REQUEST_CAPABILITY) && declared.size > 0;
  const accepted: number[] = [];
  let inFlight = false;
  let invalidated = false;
  let loads = 0;
  let ready = false;
  let locale = options.locale;

  const reply = (message: Omit<PluginViewFrameReply, 'protocol'>) => {
    if (invalidated) return;
    try {
      options.post({ protocol: PLUGIN_VIEW_FRAME_PROTOCOL, ...message });
    } catch {
      // The frame went away; nothing to tell.
    }
  };

  const drop = (reason: PluginViewFrameDropReason): PluginViewFrameHandleResult => ({
    handled: false,
    reason,
  });

  async function run(requestId: string, request: PluginViewFrameActionRequest): Promise<void> {
    let result: PluginViewFrameActionResult;
    try {
      // A navigation while the dialog was open voids the allow.
      result =
        (await options.confirm(request)) && !invalidated
          ? await options.submit(request)
          : { status: 'declined' };
    } catch {
      result = { status: 'error', errorCode: 'PLUGIN_VIEW_FRAME_SUBMIT_FAILED' };
    } finally {
      inFlight = false;
    }
    reply({
      type: 'action.result',
      requestId,
      status: result.status,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    });
  }

  return {
    get invalidated() {
      return invalidated;
    },
    invalidate() {
      invalidated = true;
    },
    frameLoaded() {
      loads += 1;
      if (loads > 1) invalidated = true;
      return !invalidated;
    },
    setLocale(next) {
      if (next === locale) return;
      locale = next;
      if (ready) reply({ type: 'init', locale });
    },
    handleMessage(event) {
      if (invalidated) return drop('invalidated');
      const frameWindow = options.frameWindow();
      if (!frameWindow || event.source !== frameWindow) return drop('source');
      const data = event.data;
      const verdict = inspectFrameData(data);
      if (verdict !== 'ok') return drop(verdict);
      if (byteLength(JSON.stringify(data)) > PLUGIN_VIEW_FRAME_MAX_MESSAGE_BYTES) {
        return drop('oversize');
      }
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return drop('shape');
      const message = data as Record<string, unknown>;
      if (message.protocol !== PLUGIN_VIEW_FRAME_PROTOCOL || typeof message.type !== 'string') {
        return drop('shape');
      }
      const keys = Object.prototype.hasOwnProperty.call(MESSAGE_KEYS, message.type)
        ? MESSAGE_KEYS[message.type]
        : undefined;
      if (!keys || !hasExactKeys(message, keys)) return drop('shape');

      if (message.type === 'ready') {
        ready = true;
        reply({ type: 'init', locale });
        return { handled: true, kind: 'ready' };
      }
      if (message.type === 'resize') {
        if (typeof message.height !== 'number' || !Number.isFinite(message.height)) {
          return drop('shape');
        }
        options.onResize?.(clampPluginViewFrameHeight(message.height));
        return { handled: true, kind: 'resize' };
      }

      const { requestId, actionId } = message;
      const params = message.params ?? {};
      if (
        typeof requestId !== 'string' ||
        !REQUEST_ID.test(requestId) ||
        typeof actionId !== 'string' ||
        !ACTION_ID.test(actionId) ||
        typeof params !== 'object' ||
        params === null ||
        Array.isArray(params)
      ) {
        return drop('shape');
      }
      if (!mayRequest) return drop('capability');
      if (!declared.has(actionId)) return drop('undeclared_action');
      if (inFlight) {
        reply({
          type: 'action.result',
          requestId,
          status: 'rejected',
          errorCode: 'PLUGIN_VIEW_FRAME_BUSY',
        });
        return { handled: true, kind: 'action.request', rejected: 'PLUGIN_VIEW_FRAME_BUSY' };
      }
      const current = now();
      while (accepted.length > 0 && accepted[0] <= current - RATE_WINDOW_MS) accepted.shift();
      if (accepted.length >= PLUGIN_VIEW_FRAME_MAX_REQUESTS_PER_MINUTE) {
        reply({
          type: 'action.result',
          requestId,
          status: 'rejected',
          errorCode: 'PLUGIN_VIEW_FRAME_RATE_LIMITED',
        });
        return {
          handled: true,
          kind: 'action.request',
          rejected: 'PLUGIN_VIEW_FRAME_RATE_LIMITED',
        };
      }
      accepted.push(current);
      inFlight = true;
      const done = run(requestId, {
        pluginId: options.pluginId,
        viewId: options.viewId,
        actionId,
        // Detached copy: the frame cannot change what the dialog showed.
        params: JSON.parse(JSON.stringify(params)) as Record<string, unknown>,
      });
      return { handled: true, kind: 'action.request', done };
    },
  };
}

/** A sandboxed-iframe view as listed by the plugin-views GET. */
export interface PluginViewFrameItem {
  pluginId: string;
  viewId: string;
  title: string;
  frameUrl: string;
  capabilities: string[];
  actions: Array<{ id: string; authority: 'agent' | 'human' }>;
}

const FRAME_URL_PREFIX = '/api/headless/a2ui/plugin-views/frame?';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Iframe views of a plugin-views GET response (same-origin frame URLs only). */
export function parsePluginViewFrames(raw: unknown): PluginViewFrameItem[] {
  if (!isRecord(raw) || !isRecord(raw.data) || !Array.isArray(raw.data.views)) return [];
  return raw.data.views.flatMap((entry: unknown) => {
    if (!isRecord(entry) || entry.isolation !== 'sandboxed-iframe') return [];
    const { plugin_id: pluginId, view_id: viewId, title, frame_url: frameUrl } = entry;
    if (
      typeof pluginId !== 'string' ||
      typeof viewId !== 'string' ||
      typeof frameUrl !== 'string' ||
      !frameUrl.startsWith(FRAME_URL_PREFIX)
    ) {
      return [];
    }
    const capabilities = Array.isArray(entry.capabilities)
      ? entry.capabilities.filter((item): item is string => typeof item === 'string')
      : [];
    const actions = Array.isArray(entry.actions)
      ? entry.actions.flatMap((action: unknown) =>
          isRecord(action) &&
          typeof action.id === 'string' &&
          (action.authority === 'agent' || action.authority === 'human')
            ? [{ id: action.id, authority: action.authority as 'agent' | 'human' }]
            : []
        )
      : [];
    return [
      {
        pluginId,
        viewId,
        title: typeof title === 'string' && title ? title : viewId,
        frameUrl,
        capabilities,
        actions,
      },
    ];
  });
}
