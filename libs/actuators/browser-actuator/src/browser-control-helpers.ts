import { evaluateCondition, pathResolver } from '@agent/core';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';
import {
  removeVirtualPasskeyAuthenticator,
  setupVirtualPasskeyAuthenticator,
} from './browser-passkey-helpers.js';
import type { Page } from '@playwright/test';
import type { BrowserRuntime } from './browser-pipeline-helpers.js';

export async function opControl(
  op: string,
  params: any,
  runtime: BrowserRuntime,
  ctx: any,
  runSteps: (steps: any[], seedCtx?: any) => Promise<any>,
  resolve: Function
) {
  const runNested = async (steps: any[], seedCtx: any) => {
    const res = await runSteps(steps, seedCtx);
    if (res.status === 'failed') {
      throw new Error(
        res.results.find((entry: any) => entry.status === 'failed')?.error ||
          'nested pipeline failed'
      );
    }
    return res.context;
  };

  switch (op) {
    case 'open_tab': {
      const page = await runtime.context.newPage();
      const tabId = params.tab_id || `tab-${runtime.tabs.size + 1}`;
      browserRuntimeHelpers.registerBrowserPage(runtime, page, tabId);
      if (params.url) {
        const url = resolve(params.url);
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
          url: params.url ? resolve(params.url) : undefined,
        }
      );
    }
    case 'select_tab': {
      const tabId = resolve(params.tab_id);
      if (!runtime.tabs.has(tabId)) throw new Error(`Unknown browser tab: ${tabId}`);
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
      if (typeof (selected.page as any).bringToFront === 'function') {
        await (selected.page as any).bringToFront();
      }
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
      const sessionId = ctx.session_id || 'default';
      const message = resolve(
        params.message || 'Operator input required. Press Enter to continue.'
      );
      const continueFile = params.continue_file
        ? pathResolver.rootResolve(resolve(params.continue_file))
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
      const maxIter = params.max_iterations || 100;
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
        protocol: resolve(params.protocol || 'ctap2') as 'ctap2' | 'u2f',
        transport: resolve(params.transport || 'internal') as 'usb' | 'nfc' | 'ble' | 'internal',
        hasResidentKey: params.has_resident_key !== false,
        hasUserVerification: params.has_user_verification !== false,
        hasLargeBlob: params.has_large_blob === true,
        automaticPresenceSimulation: params.automatic_presence !== false,
        isUserVerified: params.user_verified !== false,
      });
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          [params.export_as || 'passkey_authenticator']: setup,
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
      const { resolveRef } = await import('@agent/core');
      const refPath = resolve(params.path);
      const bindResolved: Record<string, any> = {};
      if (params.bind) {
        for (const [k, v] of Object.entries(params.bind as Record<string, any>)) {
          bindResolved[k] = resolve(v);
        }
      }
      const refResult = await resolveRef(refPath, bindResolved, ctx, resolve as (val: any) => any);
      const subCtx = await runNested(refResult.steps, { ...ctx, ...refResult.mergedCtx });
      if (params.export_as) {
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
