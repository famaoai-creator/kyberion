import { evaluateCondition } from '@agent/core/src/logic-utils';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import { isRecord } from '@agent/core/foundation';
import type { AdfRunResult, AdfStep } from '@agent/core/adf-engine';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';
import {
  removeVirtualPasskeyAuthenticator,
  setupVirtualPasskeyAuthenticator,
} from './browser-passkey-helpers.js';
import type { Page } from '@playwright/test';
import type { BrowserRuntime } from './browser-pipeline-helpers.js';

export async function opControl(
  op: string,
  params: unknown,
  runtime: BrowserRuntime,
  ctx: Record<string, unknown>,
  runSteps: (
    steps: AdfStep[],
    seedCtx?: Record<string, unknown>
  ) => Promise<AdfRunResult<Record<string, unknown>>>,
  resolve: (value: unknown) => unknown
): Promise<Record<string, unknown>> {
  if (!isRecord(params)) {
    throw new Error(`[INVALID_PARAMS] ${op} control params must be an object`);
  }
  const runNested = async (steps: unknown, seedCtx: Record<string, unknown>) => {
    const res = await runSteps(asAdfSteps(steps, op), seedCtx);
    if (res.status === 'failed') {
      throw new Error(
        res.results.find((entry) => entry.status === 'failed')?.error || 'nested pipeline failed'
      );
    }
    return res.context;
  };

  switch (op) {
    case 'open_tab': {
      const page = await runtime.context.newPage();
      const tabId =
        typeof params.tab_id === 'string' && params.tab_id.trim()
          ? params.tab_id
          : `tab-${runtime.tabs.size + 1}`;
      const resolvedUrl = params.url ? resolve(params.url) : undefined;
      browserRuntimeHelpers.registerBrowserPage(runtime, page, tabId);
      if (params.url) {
        if (typeof resolvedUrl !== 'string' || !resolvedUrl.trim()) {
          throw new Error('open_tab requires a non-empty url');
        }
        const url = resolvedUrl;
        browserRuntimeHelpers.assertNavigationAllowed(url, runtime.navigationPolicy);
        await page.goto(url, { waitUntil: params.waitUntil || 'networkidle' });
      }
      if (params.select !== false) runtime.activeTabId = tabId;
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          active_tab_id: runtime.activeTabId,
          browser_tabs: await browserRuntimeHelpers.summarizeTabs(runtime),
        },
        {
          kind: 'control',
          op: 'open_tab',
          tab_id: tabId,
          url: typeof resolvedUrl === 'string' ? resolvedUrl : undefined,
        }
      );
    }
    case 'select_tab': {
      const tabId = resolve(params.tab_id);
      if (typeof tabId !== 'string' || !runtime.tabs.has(tabId)) {
        throw new Error(`Unknown browser tab: ${String(tabId)}`);
      }
      runtime.activeTabId = tabId;
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          active_tab_id: runtime.activeTabId,
          browser_tabs: await browserRuntimeHelpers.summarizeTabs(runtime),
        },
        {
          kind: 'control',
          op: 'select_tab',
          tab_id: tabId,
        }
      );
    }
    case 'select_tab_matching': {
      const urlIncludes = params.url_includes ? String(resolve(params.url_includes)) : undefined;
      const titleIncludes = params.title_includes
        ? String(resolve(params.title_includes))
        : undefined;
      if (!urlIncludes && !titleIncludes) {
        throw new Error('select_tab_matching requires url_includes or title_includes');
      }

      let selected: { tabId: string; page: Page; url: string; title: string } | undefined;
      for (const [tabId, page] of runtime.tabs.entries()) {
        if (typeof page.isClosed === 'function' && page.isClosed()) continue;
        const url = page.url();
        const title = await page.title();
        if (urlIncludes && !url.includes(urlIncludes)) continue;
        if (titleIncludes && !title.includes(titleIncludes)) continue;
        selected = { tabId, page, url, title };
        break;
      }

      if (!selected) {
        throw new Error(
          `No browser tab matched url_includes=${urlIncludes || '*'} title_includes=${titleIncludes || '*'}`
        );
      }

      runtime.activeTabId = selected.tabId;
      const bringToFront = (selected.page as Page & { bringToFront?: () => Promise<void> })
        .bringToFront;
      if (typeof bringToFront === 'function') await bringToFront.call(selected.page);
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          active_tab_id: runtime.activeTabId,
          browser_tabs: await browserRuntimeHelpers.summarizeTabs(runtime),
        },
        {
          kind: 'control',
          op: 'select_tab_matching',
          tab_id: selected.tabId,
          url: selected.url,
        }
      );
    }
    case 'close_session':
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          __close_browser_session: true,
        },
        {
          kind: 'control',
          op: 'close_session',
          tab_id: runtime.activeTabId,
        }
      );
    case 'pause_for_operator': {
      const sessionId = typeof ctx.session_id === 'string' ? ctx.session_id : 'default';
      const message = String(
        resolve(params.message || 'Operator input required. Press Enter to continue.')
      );
      const continueFile = params.continue_file
        ? assertSafeRepositoryPath(
            pathResolver.rootResolve(String(resolve(params.continue_file))),
            {
              allowMissingLeaf: true,
            }
          )
        : pathResolver.shared(`runtime/browser/${sessionId}.continue`);
      const approval = browserRuntimeHelpers.beginOperatorApproval({
        sessionId,
        message,
        continueFile,
        timeoutMs: params.timeout_ms ? Number(params.timeout_ms) : undefined,
      });
      try {
        await browserRuntimeHelpers.waitForOperatorContinue({
          sessionId,
          message,
          continueFile,
          pollMs: Number(params.poll_ms || 250),
          timeoutMs: params.timeout_ms ? Number(params.timeout_ms) : undefined,
        });
        browserRuntimeHelpers.completeOperatorApproval(sessionId, 'approved');
        return browserRuntimeHelpers.recordBrowserAction(ctx, {
          kind: 'control',
          op: 'pause_for_operator',
          tab_id: runtime.activeTabId,
          approval_request_id: approval.request_id,
          resume_status: 'approved',
        });
      } catch (error) {
        browserRuntimeHelpers.completeOperatorApproval(sessionId, 'expired');
        throw error;
      }
    }
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        return await runNested(params.then, ctx);
      } else if (params.else) {
        return await runNested(params.else, ctx);
      }
      return ctx;
    case 'while': {
      let iterations = 0;
      const maxIter =
        typeof params.max_iterations === 'number' && params.max_iterations >= 0
          ? params.max_iterations
          : 100;
      while (evaluateCondition(params.condition, ctx) && iterations < maxIter) {
        ctx = await runNested(params.pipeline, ctx);
        iterations++;
      }
      return ctx;
    }
    case 'setup_passkey_authenticator': {
      const page = browserRuntimeHelpers.getActivePage(runtime);
      const setup = await setupVirtualPasskeyAuthenticator(runtime, page, {
        enableUI: params.enable_ui === true,
        replaceExisting: params.replace_existing !== false,
        protocol: String(resolve(params.protocol || 'ctap2')) as 'ctap2' | 'u2f',
        transport: String(resolve(params.transport || 'internal')) as
          'usb' | 'nfc' | 'ble' | 'internal',
        hasResidentKey: params.has_resident_key !== false,
        hasUserVerification: params.has_user_verification !== false,
        hasLargeBlob: params.has_large_blob === true,
        automaticPresenceSimulation: params.automatic_presence !== false,
        isUserVerified: params.user_verified !== false,
      });
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          [typeof params.export_as === 'string' && params.export_as
            ? params.export_as
            : 'passkey_authenticator']: setup,
        },
        {
          kind: 'control',
          op: 'setup_passkey_authenticator',
          tab_id: runtime.activeTabId,
        }
      );
    }
    case 'remove_passkey_authenticator': {
      const page = browserRuntimeHelpers.getActivePage(runtime);
      await removeVirtualPasskeyAuthenticator(runtime, page);
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'control',
        op: 'remove_passkey_authenticator',
        tab_id: runtime.activeTabId,
      });
    }
    case 'ref': {
      const { resolveRef } = await import('@agent/core/src/pipeline-engine');
      const resolvedPath = resolve(params.path);
      if (typeof resolvedPath !== 'string' || !resolvedPath.trim()) {
        throw new Error('Browser-Actuator ref control requires a non-empty path');
      }
      const bindResolved: Record<string, unknown> = {};
      if (isRecord(params.bind)) {
        for (const [k, v] of Object.entries(params.bind)) {
          bindResolved[k] = resolve(v);
        }
      }
      const refResult = await resolveRef(resolvedPath, bindResolved, ctx, resolve);
      const subCtx = await runNested(refResult.steps, { ...ctx, ...refResult.mergedCtx });
      if (typeof params.export_as === 'string' && params.export_as) {
        ctx = { ...ctx, [params.export_as]: subCtx };
      } else {
        const { _refDepth, ...subCtxClean } = subCtx || {};
        ctx = { ...ctx, ...subCtxClean };
      }
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'control',
        op: 'ref',
        tab_id: runtime.activeTabId,
      });
    }
    default:
      throw new Error(`Unsupported control operator in Browser-Actuator: ${op}`);
  }
}

function asAdfSteps(value: unknown, op: string): AdfStep[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (step): step is AdfStep =>
        isRecord(step) &&
        typeof step.op === 'string' &&
        (step.type === 'capture' ||
          step.type === 'transform' ||
          step.type === 'apply' ||
          step.type === 'control')
    )
  ) {
    throw new Error(`[INVALID_PARAMS] ${op} control requires an array of ADF steps`);
  }
  return value;
}
