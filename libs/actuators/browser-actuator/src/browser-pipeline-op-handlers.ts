/**
 * Browser op handler maps keyed by op name (RS-07). The bodies are the former
 * `switch (op)` cases of browser-pipeline-helpers.ts moved verbatim; the
 * dispatchers there look a handler up here. Tests assert the keys match the
 * actuator op registry (op-handler-map.test.ts).
 */
import { logger } from '@agent/core/core';
import { safeWriteFile, safeMkdir, safeExistsSync, safeReaddir } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { getPathValue } from '@agent/core/logic-utils';
import { retry } from '@agent/core/async-utils';
import { processUntrustedContent } from '@agent/core/untrusted-content';
import { executeLlmDecideOp } from '@agent/core/semantic-decide';
import { getSecret } from '@agent/core/secret/secret-guard';
import { clamp, nowIso } from '@agent/core/foundation';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';
import { resolveRefOrRecordedTarget } from './recorded-ref-resolver.js';
import {
  registerPasskey,
  authenticatePasskey,
  deletePasskey,
  getVirtualPasskeyCredentials,
  getPasskeyAuthenticatorId,
  getOrCreatePageCdpSession,
} from './browser-passkey-helpers.js';
import { listBrowserProfiles } from './browser-profile-manager.js';
import * as browserMarks from './browser-mark-target.js';
import * as path from 'node:path';
import type {
  BrowserRuntime,
  BrowserRuntimeLeaseLike,
  buildRetryOptions,
  distillDomInventory,
  fillWithFallback,
  opApply,
  opCapture,
  opTransform,
  recordedRefTargetFromParams,
  recordedSecretDomPath,
  resolveBrowserRepositoryPath,
} from './browser-pipeline-helpers.js';

/**
 * Pipeline helpers the handlers call, injected by the dispatchers in
 * browser-pipeline-helpers.ts (avoids a runtime import cycle; handler bodies
 * use them by their original names via destructuring).
 */
export interface BrowserOpSupport {
  buildRetryOptions: typeof buildRetryOptions;
  distillDomInventory: typeof distillDomInventory;
  fillWithFallback: typeof fillWithFallback;
  opApply: typeof opApply;
  recordedRefTargetFromParams: typeof recordedRefTargetFromParams;
  recordedSecretDomPath: typeof recordedSecretDomPath;
  resolveBrowserRepositoryPath: typeof resolveBrowserRepositoryPath;
}

export interface BrowserCaptureOpHandlerInput extends BrowserOpSupport {
  op: string;
  params: Parameters<typeof opCapture>[1];
  runtime: BrowserRuntime;
  ctx: Parameters<typeof opCapture>[3];
  resolve: Function;
  page: ReturnType<typeof browserRuntimeHelpers.getActivePage>;
}
export type BrowserCaptureOpHandler = (
  input: BrowserCaptureOpHandlerInput
) => Promise<Parameters<typeof opCapture>[3]>;

const BROWSER_CAPTURE_OP_HANDLERS_SHARED_0: BrowserCaptureOpHandler = async ({
  op,
  params,
  runtime,
  ctx,
  resolve,
  page,
}) => {
  const url = resolve(params.url);
  browserRuntimeHelpers.assertNavigationAllowed(url, runtime.navigationPolicy);
  await page.goto(url, { waitUntil: params.waitUntil || 'networkidle' });
  return browserRuntimeHelpers.recordBrowserAction(
    { ...ctx, last_url: page.url() },
    {
      kind: 'capture',
      op: 'goto',
      tab_id: runtime.activeTabId,
      url,
    }
  );
};
/** Op handlers keyed by op name (RS-07: mechanical replacement of the former switch). */
export const BROWSER_CAPTURE_OP_HANDLERS: Readonly<Record<string, BrowserCaptureOpHandler>> = {
  navigate: BROWSER_CAPTURE_OP_HANDLERS_SHARED_0,
  goto: BROWSER_CAPTURE_OP_HANDLERS_SHARED_0,
  tabs: async ({ op, params, runtime, ctx }) => {
    return browserRuntimeHelpers.recordBrowserAction(
      {
        ...ctx,
        browser_tabs: await browserRuntimeHelpers.summarizeTabs(runtime),
        [params.export_as || 'browser_tabs']: await browserRuntimeHelpers.summarizeTabs(runtime),
      },
      {
        kind: 'capture',
        op: 'tabs',
        tab_id: runtime.activeTabId,
      }
    );
  },
  snapshot: async ({ op, params, runtime, ctx, page }) => {
    const snapshot = await browserRuntimeHelpers.buildSnapshot(page, {
      sessionId: ctx.session_id || 'default',
      tabId: runtime.activeTabId,
      maxElements: Number(params.max_elements || 200),
    });
    browserRuntimeHelpers.saveBrowserSessionSnapshot(ctx.session_id || 'default', snapshot);
    return browserRuntimeHelpers.recordBrowserAction(
      {
        ...ctx,
        last_snapshot: snapshot,
        last_snapshot_id: browserMarks.browserSnapshotId(snapshot),
        last_capture: snapshot,
        ref_map: Object.fromEntries(
          snapshot.elements.map((element) => [element.ref, element.selector])
        ),
        [params.export_as || 'last_snapshot']: snapshot,
      },
      {
        kind: 'capture',
        op: 'snapshot',
        tab_id: runtime.activeTabId,
        url: snapshot.url,
        title: snapshot.title,
      }
    );
  },
  extract_text_ref: async ({
    op,
    params,
    runtime,
    ctx,
    resolve,
    page,
    recordedRefTargetFromParams,
  }) => {
    const ref = resolve(params.ref);
    const { selector, ctx: resolvedCtx } = await resolveRefOrRecordedTarget(
      ctx,
      ref,
      page,
      recordedRefTargetFromParams(params, { requireDomPathMatch: Boolean(params.high_risk) })
    );
    const rawContent = await page.innerText(selector);
    const content = processUntrustedContent(rawContent, `web:${page.url()}`).wrapped;
    return browserRuntimeHelpers.recordBrowserAction(
      {
        ...resolvedCtx,
        last_capture: content,
        [params.export_as || 'last_capture']: content,
      },
      {
        kind: 'capture',
        op: 'extract_text_ref',
        tab_id: runtime.activeTabId,
        ref,
        selector,
        content_excerpt: rawContent.trim().slice(0, 120),
      }
    );
  },
  session_health: async ({ op, params, runtime, ctx }) => {
    const health = await browserRuntimeHelpers.getSessionHealth(
      ctx.session_id || 'default',
      runtime,
      ctx.action_trail
    );
    return browserRuntimeHelpers.recordBrowserAction(
      { ...ctx, last_capture: health, [params.export_as || 'browser_health']: health },
      { kind: 'capture', op: 'session_health', tab_id: runtime.activeTabId }
    );
  },
  action_trail: async ({ op, params, runtime, ctx }) => {
    const source = browserRuntimeHelpers.readRecordedActions(ctx, params.from);
    const trail = source.slice(-clamp(Number(params.limit || 50), 1, 2000));
    return browserRuntimeHelpers.recordBrowserAction(
      { ...ctx, last_capture: trail, [params.export_as || 'action_trail']: trail },
      { kind: 'capture', op: 'action_trail', tab_id: runtime.activeTabId }
    );
  },
  console: async ({ op, params, runtime, ctx }) => {
    return browserRuntimeHelpers.recordBrowserAction(
      {
        ...ctx,
        [params.export_as || 'console_events']: runtime.consoleEvents.slice(-(params.limit || 50)),
      },
      {
        kind: 'capture',
        op: 'console',
        tab_id: runtime.activeTabId,
      }
    );
  },
  network: async ({ op, params, runtime, ctx }) => {
    return browserRuntimeHelpers.recordBrowserAction(
      {
        ...ctx,
        [params.export_as || 'network_events']: runtime.networkEvents.slice(-(params.limit || 50)),
      },
      {
        kind: 'capture',
        op: 'network',
        tab_id: runtime.activeTabId,
      }
    );
  },
  screenshot: async ({ op, params, runtime, ctx, resolve, page, resolveBrowserRepositoryPath }) => {
    const outPath = resolveBrowserRepositoryPath(
      resolve(params.path || `evidence/browser/screenshot_${Date.now()}.png`)
    );
    logger.info(`📸 [BROWSER] Taking screenshot to: ${outPath}`);
    if (!safeExistsSync(path.dirname(outPath)))
      safeMkdir(path.dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath, fullPage: params.fullPage });
    return browserRuntimeHelpers.recordBrowserAction(
      { ...ctx, [params.export_as || 'last_screenshot']: outPath },
      {
        kind: 'capture',
        op: 'screenshot',
        tab_id: runtime.activeTabId,
        url: page.url(),
      }
    );
  },
  content: async ({ op, params, runtime, ctx, resolve, page }) => {
    const selector = params.selector ? resolve(params.selector) : undefined;
    const rawContent = selector ? await page.innerText(selector) : await page.content();
    const content =
      typeof rawContent === 'string'
        ? processUntrustedContent(rawContent, `web:${page.url()}`).wrapped
        : rawContent;
    return browserRuntimeHelpers.recordBrowserAction(
      { ...ctx, [params.export_as || 'last_capture']: content },
      {
        kind: 'capture',
        op: 'content',
        tab_id: runtime.activeTabId,
        selector,
        content_excerpt:
          typeof rawContent === 'string' ? rawContent.trim().slice(0, 120) : undefined,
      }
    );
  },
  evaluate: async ({ op, params, runtime, ctx, page }) => {
    return browserRuntimeHelpers.recordBrowserAction(
      { ...ctx, [params.export_as || 'last_capture']: await page.evaluate(params.script) },
      {
        kind: 'capture',
        op: 'evaluate',
        tab_id: runtime.activeTabId,
      }
    );
  },
  query_elements: async ({ op, params, runtime, ctx, resolve, page }) => {
    // Count visible elements matching a selector (and optional text). Result is
    // stored to `export_as` so a `while`/`if` condition can read it — the
    // declarative equivalent of "is there still a button to process?".
    const selector = resolve(params.selector || '*');
    const textMatch =
      params.text != null
        ? String(resolve(params.text))
        : params.text_match != null
          ? String(resolve(params.text_match))
          : null;
    const exact = params.exact === true;
    const count = await page.evaluate(
      (args: { selector: string; textMatch: string | null; exact: boolean }) => {
        const els = Array.from(document.querySelectorAll(args.selector)) as HTMLElement[];
        const visible = els.filter((el) => el.offsetParent !== null);
        if (args.textMatch == null) return visible.length;
        return visible.filter((el) => {
          const label = (el.textContent || (el as HTMLInputElement).value || '').trim();
          return args.exact ? label === args.textMatch : label.includes(args.textMatch);
        }).length;
      },
      { selector, textMatch, exact }
    );
    return browserRuntimeHelpers.recordBrowserAction(
      { ...ctx, [params.export_as || 'element_count']: count },
      { kind: 'capture', op: 'query_elements', tab_id: runtime.activeTabId, selector }
    );
  },
  distill_dom: async ({ op, params, runtime, ctx, page, distillDomInventory }) => {
    // AR-07: deterministic interactive-element inventory for in-loop
    // decisions (same DOM -> same output; capped).
    const inventory = await distillDomInventory(page, {
      maxElements: typeof params.max_elements === 'number' ? params.max_elements : undefined,
    });
    return browserRuntimeHelpers.recordBrowserAction(
      { ...ctx, [params.export_as || 'dom_distillate']: inventory },
      { kind: 'capture', op: 'distill_dom', tab_id: runtime.activeTabId }
    );
  },
  llm_decide: async ({ op, params, runtime, ctx, resolve }) => {
    // AR-07: one in-loop decision about a distilled observation. With
    // params.options the reply must be a member (selection mode); a null
    // decision exports null and downstream `if` conditions handle it —
    // the op itself never throws on model failure.
    const decided = await executeLlmDecideOp({
      params,
      ctx,
      resolve: resolve as (value: any) => any,
      defaultFromKey: 'dom_distillate',
    });
    return browserRuntimeHelpers.recordBrowserAction(decided, {
      kind: 'capture',
      op: 'llm_decide',
      tab_id: runtime.activeTabId,
    });
  },
  passkey_credentials: async ({ op, params, runtime, ctx, page }) => {
    const credentials = await getVirtualPasskeyCredentials(runtime, page);
    return browserRuntimeHelpers.recordBrowserAction(
      {
        ...ctx,
        [params.export_as || 'passkey_credentials']: credentials,
      },
      {
        kind: 'capture',
        op: 'passkey_credentials',
        tab_id: runtime.activeTabId,
      }
    );
  },
  passkey_events: async ({ op, params, runtime, ctx }) => {
    return browserRuntimeHelpers.recordBrowserAction(
      {
        ...ctx,
        [params.export_as || 'passkey_events']: runtime.webAuthn?.events || [],
      },
      {
        kind: 'capture',
        op: 'passkey_events',
        tab_id: runtime.activeTabId,
      }
    );
  },
  export_session_handoff: async ({
    op,
    params,
    runtime,
    ctx,
    resolve,
    page,
    resolveBrowserRepositoryPath,
  }) => {
    const targetUrl = String(resolve(params.target_url || page.url())).trim();
    const origin = browserRuntimeHelpers.deriveOrigin(targetUrl || page.url());
    const handoff = await browserRuntimeHelpers.buildSessionHandoff(page, runtime, ctx, {
      targetUrl,
      origin,
      browserSessionId: resolve(params.browser_session_id || ctx.session_id || 'default'),
      preferPersistentContext: params.prefer_persistent_context !== false,
    });
    const outPath = params.path ? resolveBrowserRepositoryPath(resolve(params.path)) : undefined;
    if (outPath) {
      if (!safeExistsSync(path.dirname(outPath)))
        safeMkdir(path.dirname(outPath), { recursive: true });
      safeWriteFile(outPath, JSON.stringify(handoff, null, 2));
    }
    return browserRuntimeHelpers.recordBrowserAction(
      {
        ...ctx,
        [params.export_as || 'session_handoff']: handoff,
        ...(outPath ? { session_handoff_path: outPath } : {}),
      },
      {
        kind: 'capture',
        op: 'export_session_handoff',
        tab_id: runtime.activeTabId,
        url: targetUrl,
      }
    );
  },
  title: async ({ op, params, runtime, ctx, page }) => {
    return browserRuntimeHelpers.recordBrowserAction(
      { ...ctx, [params.export_as || 'page_title']: await page.title() },
      {
        kind: 'capture',
        op: 'title',
        tab_id: runtime.activeTabId,
      }
    );
  },
  url: async ({ op, params, runtime, ctx, page }) => {
    return browserRuntimeHelpers.recordBrowserAction(
      { ...ctx, [params.export_as || 'current_url']: page.url() },
      {
        kind: 'capture',
        op: 'url',
        tab_id: runtime.activeTabId,
      }
    );
  },
};

export interface BrowserTransformOpHandlerInput extends BrowserOpSupport {
  op: string;
  params: Parameters<typeof opTransform>[1];
  ctx: Parameters<typeof opTransform>[2];
  resolve: Function;
}
export type BrowserTransformOpHandler = (
  input: BrowserTransformOpHandlerInput
) => Promise<Parameters<typeof opTransform>[2]>;

/** Op handlers keyed by op name (RS-07: mechanical replacement of the former switch). */
export const BROWSER_TRANSFORM_OP_HANDLERS: Readonly<Record<string, BrowserTransformOpHandler>> = {
  regex_extract: async ({ params, ctx }) => {
    const input = String(ctx[params.from || 'last_capture'] || '');
    const match = input.match(new RegExp(params.pattern, 'm'));
    return { ...ctx, [params.export_as]: match ? match[1] : null };
  },
  json_query: async ({ params, ctx }) => {
    const data = ctx[params.from || 'last_capture'];
    const res = getPathValue(data, params.path);
    return { ...ctx, [params.export_as]: res };
  },
  export_playwright: async ({ params, ctx, resolve, resolveBrowserRepositoryPath }) => {
    const trail = browserRuntimeHelpers.readRecordedActions(ctx, params.from);
    const outPath = resolveBrowserRepositoryPath(
      resolve(
        params.path || `active/shared/tmp/browser/${ctx.session_id || 'default'}-playwright.spec.ts`
      )
    );
    if (!safeExistsSync(path.dirname(outPath)))
      safeMkdir(path.dirname(outPath), { recursive: true });
    const content = browserRuntimeHelpers.renderPlaywrightSkeleton(trail, {
      assertions: params.assertions === 'hint' ? 'hint' : 'strict',
    });
    safeWriteFile(outPath, content);
    return { ...ctx, [params.export_as || 'playwright_spec_path']: outPath };
  },
  export_adf: async ({ params, ctx, resolve, resolveBrowserRepositoryPath }) => {
    const trail = browserRuntimeHelpers.readRecordedActions(ctx, params.from);
    const outPath = resolveBrowserRepositoryPath(
      resolve(
        params.path || `active/shared/tmp/browser/${ctx.session_id || 'default'}-pipeline.json`
      )
    );
    if (!safeExistsSync(path.dirname(outPath)))
      safeMkdir(path.dirname(outPath), { recursive: true });
    const adf = browserRuntimeHelpers.renderBrowserAdf(trail, ctx.session_id || 'default');
    safeWriteFile(outPath, JSON.stringify(adf, null, 2));
    return { ...ctx, [params.export_as || 'adf_path']: outPath };
  },
  export_failure_bundle: async ({ params, ctx, resolve }) => {
    const trail = browserRuntimeHelpers.readRecordedActions(ctx, params.from).slice(-200);
    const bundle = {
      schema_version: 'browser-failure-bundle.v1',
      session_id: ctx.session_id || 'default',
      created_at: nowIso(),
      error: ctx.error || ctx.last_error || null,
      url: ctx.last_url || ctx.last_snapshot?.url || null,
      title: ctx.last_snapshot?.title || null,
      snapshot: ctx.last_snapshot || null,
      screenshot: ctx.last_screenshot || null,
      trace_path: ctx.last_trace_path || ctx.trace_persisted_path || null,
      console_events: Array.isArray(ctx.console_events) ? ctx.console_events.slice(-50) : [],
      network_events: Array.isArray(ctx.network_events) ? ctx.network_events.slice(-50) : [],
      action_trail: trail,
    };
    const outPath = browserRuntimeHelpers.saveFailureBundle(
      ctx.session_id || 'default',
      bundle,
      params.path ? resolve(params.path) : undefined
    );
    return {
      ...ctx,
      failure_bundle: bundle,
      [params.export_as || 'failure_bundle_path']: outPath,
    };
  },
};

export interface BrowserApplyOpHandlerInput extends BrowserOpSupport {
  op: string;
  params: Parameters<typeof opApply>[1];
  runtime: BrowserRuntime;
  ctx: Parameters<typeof opApply>[3];
  resolve: Function;
  page: ReturnType<typeof browserRuntimeHelpers.getActivePage>;
}
export type BrowserApplyOpHandler = (
  input: BrowserApplyOpHandlerInput
) => Promise<Parameters<typeof opApply>[3]>;

const BROWSER_APPLY_OP_HANDLERS_SHARED_0: BrowserApplyOpHandler = async ({
  op,
  params,
  runtime,
  ctx,
  resolve,
  page,
  buildRetryOptions,
}) => {
  const url = resolve(params.url);
  browserRuntimeHelpers.assertNavigationAllowed(url, runtime.navigationPolicy);
  await retry(async () => {
    await page.goto(url, { waitUntil: params.waitUntil || 'networkidle' });
  }, buildRetryOptions(params));
  return browserRuntimeHelpers.recordBrowserAction(
    { ...ctx, last_url: page.url() },
    {
      kind: 'apply',
      op: 'goto',
      tab_id: runtime.activeTabId,
      url,
    }
  );
};
/** Op handlers keyed by op name (RS-07: mechanical replacement of the former switch). */
export const BROWSER_APPLY_OP_HANDLERS: Readonly<Record<string, BrowserApplyOpHandler>> = {
  navigate: BROWSER_APPLY_OP_HANDLERS_SHARED_0,
  goto: BROWSER_APPLY_OP_HANDLERS_SHARED_0,
  click: async ({ op, params, runtime, ctx, resolve, page, buildRetryOptions, opApply }) => {
    if (params.ref != null && String(params.ref).trim() !== '') {
      return opApply('click_ref', params, runtime, ctx, resolve);
    }
    await retry(async () => {
      await page.click(resolve(params.selector), { timeout: params.timeout || 5000 });
    }, buildRetryOptions(params));
    return browserRuntimeHelpers.recordBrowserAction(ctx, {
      kind: 'apply',
      op: 'click',
      tab_id: runtime.activeTabId,
      selector: resolve(params.selector),
    });
  },
  click_first_match: async ({ op, params, runtime, ctx, resolve, page }) => {
    // Click the first VISIBLE element matching any of the fallback selectors
    // (optionally constrained by text). Declarative resilience against UIs that
    // vary their markup (the equivalent of try-these-selectors-in-order).
    const selectors = (Array.isArray(params.selectors) ? params.selectors : [params.selector])
      .filter(Boolean)
      .map((sel: string) => resolve(sel));
    const text = params.text != null ? String(resolve(params.text)) : null;
    const exact = params.exact === true;
    const clicked = await page.evaluate(
      (args: { selectors: string[]; text: string | null; exact: boolean }) => {
        for (const selector of args.selectors) {
          const els = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
          for (const el of els) {
            if (el.offsetParent === null) continue; // visible only
            const label = (el.textContent || (el as HTMLInputElement).value || '').trim();
            if (
              args.text != null &&
              !(args.exact ? label === args.text : label.includes(args.text))
            )
              continue;
            el.click();
            return label || selector;
          }
        }
        return null;
      },
      { selectors, text, exact }
    );
    return browserRuntimeHelpers.recordBrowserAction(
      { ...ctx, [params.export_as || 'clicked_match']: clicked },
      {
        kind: 'apply',
        op: 'click_first_match',
        tab_id: runtime.activeTabId,
        text: clicked ?? '(none)',
      }
    );
  },
  fill: async ({
    op,
    params,
    runtime,
    ctx,
    resolve,
    page,
    buildRetryOptions,
    fillWithFallback,
  }) => {
    const fillResult = await retry(
      async () =>
        fillWithFallback(page, {
          selector: resolve(params.selector),
          text: resolve(params.text),
          timeoutMs: params.timeout || 5000,
          fieldHint: params.field ? resolve(params.field) : undefined,
        }),
      buildRetryOptions(params)
    );
    return browserRuntimeHelpers.recordBrowserAction(ctx, {
      kind: 'apply',
      op: 'fill',
      tab_id: runtime.activeTabId,
      selector: resolve(params.selector),
      text: resolve(params.text),
      ...(fillResult.strategy !== 'selector' ? { fallback_strategy: fillResult.strategy } : {}),
    });
  },
  press: async ({ op, params, runtime, ctx, resolve, page, buildRetryOptions }) => {
    await retry(async () => {
      await page.press(resolve(params.selector), resolve(params.key), {
        timeout: params.timeout || 5000,
      });
    }, buildRetryOptions(params));
    return browserRuntimeHelpers.recordBrowserAction(ctx, {
      kind: 'apply',
      op: 'press',
      tab_id: runtime.activeTabId,
      selector: resolve(params.selector),
      key: resolve(params.key),
    });
  },
  click_ref: async ({
    op,
    params,
    runtime,
    ctx,
    resolve,
    page,
    buildRetryOptions,
    recordedRefTargetFromParams,
  }) => {
    let ref = resolve(params.ref);
    if (browserMarks.isMarkTarget(ref)) {
      const target = await browserMarks.resolveBrowserMarkTarget(ref, {
        params,
        sessionId: ctx.session_id || 'default',
        currentSnapshotId: browserMarks.browserSnapshotId(ctx.last_snapshot),
        captureScreen: () => page.screenshot(),
      });
      if (target.kind === 'point') {
        await retry(async () => {
          await page.mouse.click(target.x, target.y);
        }, buildRetryOptions(params));
        return browserRuntimeHelpers.recordBrowserAction(
          { ...ctx, last_url: page.url() },
          {
            kind: 'apply',
            op: 'click_ref',
            tab_id: runtime.activeTabId,
            ref,
            element_name: target.mark.label,
          }
        );
      }
      ref = target.ref;
    }
    const { selector, ctx: resolvedCtx } = await resolveRefOrRecordedTarget(
      ctx,
      ref,
      page,
      recordedRefTargetFromParams(params, { requireDomPathMatch: Boolean(params.high_risk) })
    );
    const element = browserRuntimeHelpers.findSnapshotElement(resolvedCtx, ref);
    await retry(async () => {
      await page.click(selector, { timeout: params.timeout || 5000 });
    }, buildRetryOptions(params));
    return browserRuntimeHelpers.recordBrowserAction(
      { ...resolvedCtx, last_url: page.url() },
      {
        kind: 'apply',
        op: 'click_ref',
        tab_id: runtime.activeTabId,
        ref,
        selector,
        element_name: element?.name ?? params.name,
        element_role: element?.role ?? params.role,
      }
    );
  },
  fill_ref: async ({
    op,
    params,
    runtime,
    ctx,
    resolve,
    page,
    buildRetryOptions,
    recordedRefTargetFromParams,
    recordedSecretDomPath,
  }) => {
    const ref = resolve(params.ref);
    const secretKey = params.secret_ref
      ? String(resolve(params.secret_ref))
      : params.classification === 'secret_ref' && params.variable?.name
        ? String(resolve(params.variable.name))
        : undefined;
    // Secret-bearing fills must corroborate the role/name match against
    // dom_path (or fail closed if no dom_path was recorded) — a relabeled
    // live element must never receive a secret value. See
    // RecordedRefSpoofSuspectedError in recorded-ref-resolver.ts.
    const { selector, ctx: resolvedCtx } = await resolveRefOrRecordedTarget(
      ctx,
      ref,
      page,
      recordedRefTargetFromParams(params, {
        requireDomPathMatch: Boolean(secretKey) || Boolean(params.high_risk),
      })
    );
    const element = browserRuntimeHelpers.findSnapshotElement(resolvedCtx, ref);
    const text = secretKey
      ? getSecret(secretKey, undefined, 'browser.fill_ref')
      : resolve(params.text);
    if (secretKey && text == null)
      throw new Error(`[BROWSER_SECRET_MISSING] SecretResolver could not resolve ${secretKey}`);
    await retry(async () => {
      await page.fill(selector, String(text ?? ''), { timeout: params.timeout || 5000 });
    }, buildRetryOptions(params));
    return browserRuntimeHelpers.recordBrowserAction(resolvedCtx, {
      kind: 'apply',
      op: 'fill_ref',
      tab_id: runtime.activeTabId,
      ref,
      selector,
      ...(secretKey
        ? {
            classification: 'secret_ref' as const,
            secret_ref: secretKey,
            dom_path: recordedSecretDomPath(params, selector),
          }
        : { text }),
      element_name: element?.name ?? params.name,
      element_role: element?.role ?? params.role,
    });
  },
  fill_secret_ref: async ({
    op,
    params,
    runtime,
    ctx,
    resolve,
    page,
    buildRetryOptions,
    recordedRefTargetFromParams,
    recordedSecretDomPath,
  }) => {
    const ref = resolve(params.ref);
    const secretKey = String(resolve(params.secret_ref));
    const secret = getSecret(secretKey, undefined, 'browser.fill_secret_ref');
    if (secret == null)
      throw new Error(`[BROWSER_SECRET_MISSING] SecretResolver could not resolve ${secretKey}`);
    const { selector, ctx: resolvedCtx } = await resolveRefOrRecordedTarget(
      ctx,
      ref,
      page,
      recordedRefTargetFromParams(params, { requireDomPathMatch: true })
    );
    const element = browserRuntimeHelpers.findSnapshotElement(resolvedCtx, ref);
    await retry(
      async () => page.fill(selector, secret, { timeout: params.timeout || 5000 }),
      buildRetryOptions(params)
    );
    return browserRuntimeHelpers.recordBrowserAction(resolvedCtx, {
      kind: 'apply',
      op: 'fill_secret_ref',
      tab_id: runtime.activeTabId,
      ref,
      selector,
      secret_ref: secretKey,
      classification: 'secret_ref',
      dom_path: recordedSecretDomPath(params, selector),
      element_name: element?.name ?? params.name,
      element_role: element?.role ?? params.role,
    });
  },
  press_ref: async ({
    op,
    params,
    runtime,
    ctx,
    resolve,
    page,
    buildRetryOptions,
    recordedRefTargetFromParams,
  }) => {
    const ref = resolve(params.ref);
    const key = resolve(params.key);
    const { selector, ctx: resolvedCtx } = await resolveRefOrRecordedTarget(
      ctx,
      ref,
      page,
      recordedRefTargetFromParams(params, { requireDomPathMatch: Boolean(params.high_risk) })
    );
    const element = browserRuntimeHelpers.findSnapshotElement(resolvedCtx, ref);
    await retry(async () => {
      await page.press(selector, key, { timeout: params.timeout || 5000 });
    }, buildRetryOptions(params));
    return browserRuntimeHelpers.recordBrowserAction(resolvedCtx, {
      kind: 'apply',
      op: 'press_ref',
      tab_id: runtime.activeTabId,
      ref,
      selector,
      key,
      element_name: element?.name ?? params.name,
      element_role: element?.role ?? params.role,
    });
  },
  scroll_ref: async ({
    op,
    params,
    runtime,
    ctx,
    resolve,
    page,
    buildRetryOptions,
    recordedRefTargetFromParams,
  }) => {
    const ref = resolve(params.ref);
    const { selector, ctx: resolvedCtx } = await resolveRefOrRecordedTarget(
      ctx,
      ref,
      page,
      recordedRefTargetFromParams(params, { requireDomPathMatch: Boolean(params.high_risk) })
    );
    const element = browserRuntimeHelpers.findSnapshotElement(resolvedCtx, ref);
    await retry(
      async () =>
        page.locator(selector).scrollIntoViewIfNeeded({ timeout: params.timeout || 5000 }),
      buildRetryOptions(params)
    );
    return browserRuntimeHelpers.recordBrowserAction(resolvedCtx, {
      kind: 'apply',
      op: 'scroll_ref',
      tab_id: runtime.activeTabId,
      ref,
      selector,
      element_name: element?.name ?? params.name,
      element_role: element?.role ?? params.role,
    });
  },
  scroll: async ({ op, params, runtime, ctx, page }) => {
    const delta = params.delta || {};
    const x = clamp(Number(params.x ?? delta.x ?? 0), -5000, 5000);
    const y = clamp(Number(params.y ?? delta.y ?? 0), -5000, 5000);
    await page.mouse.wheel(x, y);
    return browserRuntimeHelpers.recordBrowserAction(ctx, {
      kind: 'apply',
      op: 'scroll',
      tab_id: runtime.activeTabId,
      content_excerpt: `delta(${x},${y})`,
    });
  },
  wait: async ({ op, params, runtime, ctx, resolve, page, buildRetryOptions }) => {
    if (params.selector) {
      await retry(async () => {
        await page.waitForSelector(resolve(params.selector), {
          state: params.state || 'visible',
          timeout: params.timeout || 10000,
        });
      }, buildRetryOptions(params));
    } else {
      await page.waitForTimeout(params.duration || 1000);
    }
    return browserRuntimeHelpers.recordBrowserAction(ctx, {
      kind: 'apply',
      op: 'wait',
      tab_id: runtime.activeTabId,
      selector: params.selector ? resolve(params.selector) : undefined,
    });
  },
  wait_ref: async ({
    op,
    params,
    runtime,
    ctx,
    resolve,
    page,
    buildRetryOptions,
    recordedRefTargetFromParams,
  }) => {
    const ref = resolve(params.ref);
    const { selector, ctx: resolvedCtx } = await resolveRefOrRecordedTarget(
      ctx,
      ref,
      page,
      recordedRefTargetFromParams(params, { requireDomPathMatch: Boolean(params.high_risk) })
    );
    await retry(async () => {
      await page.waitForSelector(selector, {
        state: params.state || 'visible',
        timeout: params.timeout || 10000,
      });
    }, buildRetryOptions(params));
    return browserRuntimeHelpers.recordBrowserAction(resolvedCtx, {
      kind: 'apply',
      op: 'wait_ref',
      tab_id: runtime.activeTabId,
      ref,
      selector,
    });
  },
  log: async ({ op, params, runtime, ctx, resolve }) => {
    logger.info(`[BROWSER_LOG] ${resolve(params.message || 'Action completed')}`);
    return browserRuntimeHelpers.recordBrowserAction(ctx, {
      kind: 'apply',
      op: 'log',
      tab_id: runtime.activeTabId,
    });
  },
  list_profiles: async ({ op, params, runtime, ctx }) => {
    let managedProfiles: string[] = [];
    let nativeProfiles: string[] = [];
    const lease = browserRuntimeHelpers.findBrowserRuntimeLease(runtime) as
      BrowserRuntimeLeaseLike | undefined;
    try {
      const managedDir = pathResolver.rootResolve('active/shared/runtime/browser/profiles');
      if (safeExistsSync(managedDir)) {
        managedProfiles = (await safeReaddir(managedDir)).filter(
          (name) =>
            !name.startsWith('.') &&
            (safeExistsSync(path.join(managedDir, name, 'Preferences')) ||
              safeExistsSync(path.join(managedDir, name, 'Default', 'Preferences')))
        );
      }
    } catch (e) {
      /* ignore */
    }
    try {
      if (lease && safeExistsSync(lease.userDataDir)) {
        nativeProfiles = (await safeReaddir(lease.userDataDir)).filter(
          (name) => name === 'Default' || name.startsWith('Profile ')
        );
      }
    } catch (e) {
      /* ignore */
    }

    const allDiscovered = listBrowserProfiles({
      provider: (params.provider as any) || 'all',
    });

    const profilesList = {
      managed: managedProfiles,
      native: nativeProfiles,
      profiles: allDiscovered,
    };

    if (params.export_as) {
      ctx[params.export_as] = profilesList;
    }
    return browserRuntimeHelpers.recordBrowserAction(ctx, {
      kind: 'apply',
      op: 'list_profiles',
      tab_id: runtime.activeTabId,
    });
  },
  set_passkey_user_verified: async ({ op, params, runtime, ctx, page }) => {
    const authenticatorId = getPasskeyAuthenticatorId(runtime);
    const cdp = await getOrCreatePageCdpSession(runtime, page);
    await cdp.send('WebAuthn.setUserVerified', {
      authenticatorId,
      isUserVerified: params.is_user_verified !== false,
    });
    return browserRuntimeHelpers.recordBrowserAction(ctx, {
      kind: 'apply',
      op: 'set_passkey_user_verified',
      tab_id: runtime.activeTabId,
    });
  },
  set_passkey_presence: async ({ op, params, runtime, ctx, page }) => {
    const authenticatorId = getPasskeyAuthenticatorId(runtime);
    const cdp = await getOrCreatePageCdpSession(runtime, page);
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
      authenticatorId,
      enabled: params.enabled !== false,
    });
    return browserRuntimeHelpers.recordBrowserAction(ctx, {
      kind: 'apply',
      op: 'set_passkey_presence',
      tab_id: runtime.activeTabId,
    });
  },
  clear_passkey_credentials: async ({ op, runtime, ctx, page }) => {
    const authenticatorId = getPasskeyAuthenticatorId(runtime);
    const cdp = await getOrCreatePageCdpSession(runtime, page);
    await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
    if (runtime.webAuthn) runtime.webAuthn.credentials = [];
    return browserRuntimeHelpers.recordBrowserAction(ctx, {
      kind: 'apply',
      op: 'clear_passkey_credentials',
      tab_id: runtime.activeTabId,
    });
  },
  register_passkey: async ({ op, params, runtime, ctx, resolve, page }) => {
    const registration = await registerPasskey(page, runtime, ctx, params, resolve);
    return browserRuntimeHelpers.recordBrowserAction(
      {
        ...ctx,
        [params.export_as || 'passkey_registration']: registration,
        passkey_credentials: registration.credentials,
      },
      {
        kind: 'apply',
        op: 'register_passkey',
        tab_id: runtime.activeTabId,
      }
    );
  },
  authenticate_passkey: async ({ op, params, runtime, ctx, resolve, page }) => {
    const authentication = await authenticatePasskey(page, runtime, ctx, params, resolve);
    return browserRuntimeHelpers.recordBrowserAction(
      {
        ...ctx,
        [params.export_as || 'passkey_authentication']: authentication,
        passkey_credentials: authentication.credentials,
      },
      {
        kind: 'apply',
        op: 'authenticate_passkey',
        tab_id: runtime.activeTabId,
      }
    );
  },
  delete_passkey: async ({ op, params, runtime, ctx, resolve, page }) => {
    const deletion = await deletePasskey(page, runtime, ctx, params, resolve);
    return browserRuntimeHelpers.recordBrowserAction(
      {
        ...ctx,
        [params.export_as || 'passkey_deletion']: deletion,
        passkey_credentials: deletion.credentials,
      },
      {
        kind: 'apply',
        op: 'delete_passkey',
        tab_id: runtime.activeTabId,
      }
    );
  },
  import_session_handoff: async ({ op, params, runtime, ctx, resolve, page }) => {
    const handoff = await browserRuntimeHelpers.resolveSessionHandoff(
      params,
      ctx,
      resolve as (value: any) => any
    );
    if (Array.isArray(handoff.cookies) && handoff.cookies.length > 0) {
      await runtime.context.addCookies(handoff.cookies as any);
    }
    if (handoff.headers && Object.keys(handoff.headers).length > 0) {
      await runtime.context.setExtraHTTPHeaders(handoff.headers as Record<string, string>);
    }
    const targetUrl = String(handoff.target_url || resolve(params.target_url || '')).trim();
    if (!targetUrl) throw new Error('import_session_handoff requires a target_url');
    browserRuntimeHelpers.assertNavigationAllowed(targetUrl, runtime.navigationPolicy);
    await page.goto(targetUrl, { waitUntil: params.waitUntil || 'domcontentloaded' });
    if (
      (handoff.local_storage && Object.keys(handoff.local_storage).length > 0) ||
      (handoff.session_storage && Object.keys(handoff.session_storage).length > 0)
    ) {
      await page.evaluate(
        ({ localStorageEntries, sessionStorageEntries }) => {
          for (const [key, value] of Object.entries(localStorageEntries || {})) {
            window.localStorage.setItem(key, String(value));
          }
          for (const [key, value] of Object.entries(sessionStorageEntries || {})) {
            window.sessionStorage.setItem(key, String(value));
          }
        },
        {
          localStorageEntries: handoff.local_storage || {},
          sessionStorageEntries: handoff.session_storage || {},
        }
      );
      if (params.reload_after_import !== false) {
        await page.reload({ waitUntil: params.waitUntil || 'domcontentloaded' });
      }
    }
    return browserRuntimeHelpers.recordBrowserAction(
      {
        ...ctx,
        [params.export_as || 'imported_session_handoff']: handoff,
        last_url: page.url(),
      },
      {
        kind: 'apply',
        op: 'import_session_handoff',
        tab_id: runtime.activeTabId,
        url: targetUrl,
      }
    );
  },
};
