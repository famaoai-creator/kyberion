/** Human-only admission for opaque UI effects. Raw Playwright APIs are not sandboxed. */
import { runExternalOperation } from '@agent/core/governance/external-operation';
import { currentScopeEnvelope } from '@agent/core/scope-envelope';
import { resolveScopeContext } from '@agent/core/scope-context';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';
import type { BrowserRuntime } from './browser-pipeline-helpers.js';
import type { Page } from '@playwright/test';
import { assertBrowserSessionOwner } from './browser-session-scope.js';
import { isRecord } from '@agent/core/foundation';
import {
  hasIsolatedNavigationConfinement,
  permitIsolatedNavigation,
  ISOLATED_NAVIGATION_CAPABILITY,
} from './browser-navigation-confinement.js';

const READ_APPLY = new Set(['wait', 'wait_ref', 'log', 'list_profiles']);
const MUTATING_CONTROL = new Set([
  'open_tab',
  'select_tab',
  'select_tab_matching',
  'setup_passkey_authenticator',
  'remove_passkey_authenticator',
]);

export function browserOperationRequiresAdmission(kind: string, op: string): boolean {
  // `cdp` admits the same page-scoped power as `evaluate` (Runtime.evaluate,
  // Input.dispatch*), so it needs the same human admission — the domain
  // allowlist only bounds it further, never weakens it.
  if (kind === 'capture') return ['goto', 'navigate', 'evaluate', 'cdp'].includes(op);
  if (kind === 'apply') return !READ_APPLY.has(op);
  return kind === 'control' && MUTATING_CONTROL.has(op);
}

function resolvedEffect(value: unknown, resolve: Function, serializeFunctions = false): unknown {
  if (typeof value === 'function') return serializeFunctions ? String(value) : value;
  if (typeof value === 'string') return resolve(value);
  if (Array.isArray(value))
    return value.map((item) => resolvedEffect(item, resolve, serializeFunctions));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolvedEffect(item, resolve, serializeFunctions),
      ])
    );
  return value;
}

export async function runBrowserMutation<T>(
  input: {
    op: string;
    params: Record<string, unknown>;
    runtime: BrowserRuntime;
    page: Page;
    resolve: Function;
    ctx?: Record<string, unknown>;
  },
  execute: (params: Record<string, unknown>, resolve: (value: unknown) => unknown) => Promise<T>
): Promise<T> {
  const rawParams = resolvedEffect(input.params, (value: unknown) => value) as Record<
    string,
    unknown
  >;
  const resolvedStrings = new Map<string, unknown>();
  const params = resolvedEffect(rawParams, (value: string) => {
    if (!resolvedStrings.has(value)) resolvedStrings.set(value, input.resolve(value));
    return resolvedStrings.get(value);
  }) as Record<string, unknown>;
  const resolveBound = (value: unknown) =>
    typeof value === 'string' && resolvedStrings.has(value) ? resolvedStrings.get(value) : value;
  if (['goto', 'navigate', 'open_tab'].includes(input.op) && params.url !== undefined) {
    browserRuntimeHelpers.assertNavigationAllowed(
      String(params.url),
      input.runtime.navigationPolicy
    );
  }
  const pageUrl = input.page.url();
  const tabId = input.runtime.activeTabId;
  const lease = browserRuntimeHelpers.findBrowserRuntimeLease(input.runtime);
  const sessionScope = browserRuntimeHelpers.getBrowserScopeFingerprint();
  if (lease?.scopeFingerprint) assertBrowserSessionOwner(lease.scopeFingerprint, sessionScope);
  const ref = typeof params.ref === 'string' ? params.ref : undefined;
  const refMap = isRecord(input.ctx?.ref_map) ? input.ctx.ref_map : {};
  const snapshot = isRecord(input.ctx?.last_snapshot) ? input.ctx.last_snapshot : {};
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
  const refTarget = ref
    ? {
        selector: refMap[ref],
        element: elements.find((element: unknown) => isRecord(element) && element.ref === ref),
      }
    : undefined;
  return runExternalOperation(
    {
      operationId: `browser:${input.op === 'navigate' ? 'goto' : input.op}`,
      tenantSlug: (currentScopeEnvelope()?.identity ?? resolveScopeContext()).tenant_slug,
      effect: {
        session_scope: sessionScope,
        session_directory: lease?.userDataDir,
        tab_id: tabId,
        current_url: pageUrl,
        // Some contracts (notably evaluate.script) intentionally execute raw
        // strings; bind both that input and the cached template resolutions.
        requested_params: resolvedEffect(rawParams, (value: unknown) => value, true),
        ...(refTarget
          ? { ref_target: resolvedEffect(refTarget, (value: unknown) => value, true) }
          : {}),
        params: resolvedEffect(params, (value: unknown) => value, true),
        ...(hasIsolatedNavigationConfinement(input.runtime.context)
          ? { navigation_confinement: ISOLATED_NAVIGATION_CAPABILITY }
          : {}),
      },
      requiresApproval: true,
      // Request-origin checks alone do not confine redirects, service workers
      // or subresources. Existing browser contexts retain individual approval
      // until a trusted context-wide network confinement capability is bound.
      delegable:
        ['goto', 'navigate', 'open_tab'].includes(input.op) &&
        hasIsolatedNavigationConfinement(input.runtime.context),
    },
    async () => {
      if (input.runtime.activeTabId !== tabId || input.page.url() !== pageUrl) {
        throw new Error(
          '[BROWSER_TARGET_CHANGED] Revalidate the actual tab and URL before execution'
        );
      }
      if (['goto', 'navigate', 'open_tab'].includes(input.op))
        permitIsolatedNavigation(input.runtime.context, String(params.url));
      return execute(rawParams, resolveBound);
    },
    () => 'succeeded'
  );
}

/** Every exported handler entry uses the same admission, including direct callers. */
export function governBrowserHandlers<
  T extends {
    op: string;
    params: Record<string, unknown>;
    runtime: BrowserRuntime;
    page: Page;
    resolve: Function;
    buildRetryOptions: Function;
    fillWithFallback: Function;
  },
  R,
>(
  kind: 'apply' | 'capture',
  handlers: Record<string, (input: T) => Promise<R>>
): Readonly<Record<string, (input: T) => Promise<R>>> {
  return Object.fromEntries(
    Object.entries(handlers).map(([op, handler]) => [
      op,
      async (input: T) => {
        if (!browserOperationRequiresAdmission(kind, op)) return handler(input);
        // click(ref) is only a dispatcher; the resolved click_ref owns admission.
        if (op === 'click' && input.params.ref != null && String(input.params.ref).trim())
          return handler(input);
        return runBrowserMutation({ ...input, op }, (params, resolveBound) =>
          handler({
            ...input,
            op,
            params,
            resolve: resolveBound,
            buildRetryOptions: (params: unknown) => ({
              ...input.buildRetryOptions(params),
              maxRetries: 0,
            }),
            fillWithFallback: (page: Page, params: Record<string, unknown>) =>
              input.fillWithFallback(page, { ...params, singleAttempt: true }),
          })
        );
      },
    ])
  );
}

/** Nested envelopes cannot checkpoint opaque loops/ref expansion. */
export function countBrowserExternalEffects(
  steps: ReadonlyArray<{ type?: string; op: string; params?: unknown }>
): number {
  const countNested = (value: unknown): number => {
    if (value === undefined) return 0;
    if (
      !Array.isArray(value) ||
      !value.every((step) => isRecord(step) && typeof step.op === 'string')
    )
      return Number.POSITIVE_INFINITY;
    return countBrowserExternalEffects(value);
  };
  return steps.reduce((count, step) => {
    const op = step.op.replace(/^browser:/, '');
    if (op === 'ref') return Number.POSITIVE_INFINITY;
    const params = isRecord(step.params) ? step.params : {};
    const branches = Math.max(countNested(params.then), countNested(params.else));
    const body = countNested(params.pipeline);
    let nested = branches + body;
    if (op === 'while' && body > 0) {
      const iterations = params.max_iterations;
      if (
        typeof iterations !== 'number' ||
        !Number.isInteger(iterations) ||
        iterations < 0 ||
        iterations > 1
      )
        return Number.POSITIVE_INFINITY;
      nested = branches + (iterations === 0 ? 0 : body);
    }
    return count + nested + Number(browserOperationRequiresAdmission(step.type || 'apply', op));
  }, 0);
}
