import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';

vi.mock('@agent/core/governance/approval-gate', () => ({ enforceApprovalGate: vi.fn() }));
vi.mock('@agent/core/governance/audit-chain', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('@agent/core/governance/external-operation-store', () => ({
  reserveExternalOperation: vi.fn(),
}));
vi.mock('@agent/core/governance/accountability-charter-registry', () => ({
  findActiveCharter: vi.fn(() => null),
  loadCharterUsage: vi.fn(),
  recordCharterExecutionOutcome: vi.fn(),
  recordCharterExecutionStarted: vi.fn(),
}));
vi.mock('@agent/core/scope-envelope', () => ({ currentScopeEnvelope: vi.fn(() => undefined) }));
vi.mock('@agent/core/scope-context', async (original) => ({
  ...(await original<typeof import('@agent/core/scope-context')>()),
  resolveScopeContext: vi.fn(() => ({ tenant_slug: 'browser-tenant', tier: 'confidential' })),
}));
vi.mock('@agent/core/secret/secret-guard', () => ({ getSecret: vi.fn() }));

import { enforceApprovalGate } from '@agent/core/governance/approval-gate';
import { auditChain } from '@agent/core/governance/audit-chain';
import {
  withExternalOperationAuthority,
  withExternalOperationPipelineRun,
  assertExternalOperationBatchResumable,
} from '@agent/core/governance/external-operation';
import {
  opApply,
  opCapture,
  executePipeline,
  BROWSER_APPLY_OP_HANDLERS,
  type BrowserRuntime,
} from './browser-pipeline-helpers.js';
import { opControl } from './browser-control-helpers.js';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';
import { countBrowserExternalEffects } from './browser-external-governance.js';
import { runBrowserAssist } from './browser-assist.js';

const authority = {
  agentId: 'browser-worker',
  tenantSlug: 'browser-tenant',
  invocationId: 'browser-effect',
};
const resolve = (value: unknown) => value;
let page: Page;
let runtime: BrowserRuntime;

describe('browser external governance', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    page = {
      url: vi.fn(() => 'https://example.com/form'),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined),
      goto: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => 'result'),
      title: vi.fn(async () => 'Form'),
    } as unknown as Page;
    runtime = {
      tabs: new Map([['tab-1', page]]),
      activeTabId: 'tab-1',
      context: { newPage: vi.fn() },
      pageIds: new WeakMap(),
      cdpSessions: new WeakMap(),
      consoleEvents: [],
      networkEvents: [],
      navigationPolicy: { allowed_origins: ['https://example.com'] },
    };
    vi.mocked(enforceApprovalGate).mockReturnValue({
      allowed: false,
      status: 'pending',
      requestStatus: 'human_required',
    });
  });

  it('blocks direct UI mutation despite forged approval/authority params', async () => {
    await expect(
      opApply(
        'click',
        { selector: '#submit', externalAuthority: authority, approval: { allowed: true } },
        runtime,
        {},
        resolve
      )
    ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(page.click).not.toHaveBeenCalled();
    expect(enforceApprovalGate).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'external-actuator', hasHuman: false })
    );
  });

  it('gates exported raw handler entries using their canonical operation', async () => {
    await expect(
      BROWSER_APPLY_OP_HANDLERS.click({
        op: 'wait',
        params: { selector: '#submit' },
        runtime,
        page,
        ctx: {},
        resolve,
        buildRetryOptions: () => ({}),
        fillWithFallback: vi.fn(),
      } as never)
    ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(enforceApprovalGate).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'browser:click' })
    );
    expect(page.click).not.toHaveBeenCalled();
  });

  it('still gates arbitrary data HTML navigation even when the origin policy allows it', async () => {
    runtime.navigationPolicy = { allow_data_url: true };
    await expect(
      opCapture(
        'goto',
        {
          url: 'data:text/html,<script>fetch("https://outside.example")</script>',
        },
        runtime,
        {},
        resolve
      )
    ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('gates capture evaluate while keeping fixed read captures automatic', async () => {
    await expect(
      opCapture('evaluate', { script: 'fetch("https://outside.example")' }, runtime, {}, resolve)
    ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(page.evaluate).not.toHaveBeenCalled();
    vi.clearAllMocks();
    expect(await opCapture('title', {}, runtime, {}, resolve)).toMatchObject({
      page_title: 'Form',
    });
    await opCapture('url', {}, runtime, {}, resolve);
    expect(enforceApprovalGate).not.toHaveBeenCalled();
  });

  it('preserves origin restrictions before admission', async () => {
    await expect(
      opCapture('goto', { url: 'http://127.0.0.1/admin' }, runtime, {}, resolve)
    ).rejects.toThrow('BROWSER_NAVIGATION_BLOCKED');
    expect(enforceApprovalGate).not.toHaveBeenCalled();
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('checks the retained session owner before approval even for direct handlers', async () => {
    vi.spyOn(browserRuntimeHelpers, 'findBrowserRuntimeLease').mockReturnValue({
      scopeFingerprint: 'confidential:other-tenant',
    } as never);
    await expect(opApply('click', { selector: '#submit' }, runtime, {}, resolve)).rejects.toThrow(
      'BROWSER_SESSION_OWNER_MISMATCH'
    );
    expect(enforceApprovalGate).not.toHaveBeenCalled();
    expect(page.click).not.toHaveBeenCalled();
  });

  it('binds actual page/tab/target and executes one trusted human-approved click', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    const resolver = vi.fn(() => authority);
    await withExternalOperationAuthority(resolver, () =>
      opApply('click', { selector: '#submit' }, runtime, { tenant_slug: 'forged' }, resolve)
    );
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'browser:click',
        delegable: false,
        tenantSlug: 'browser-tenant',
        effect: expect.objectContaining({
          tab_id: 'tab-1',
          current_url: 'https://example.com/form',
          params: { selector: '#submit' },
        }),
      })
    );
    expect(page.click).toHaveBeenCalledTimes(1);
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'succeeded' }) })
    );
  });

  it('never retries a timed-out mutation even with explicit retry params', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    vi.mocked(page.click).mockRejectedValue(new Error('timeout after possible click'));
    await expect(
      withExternalOperationAuthority(
        () => authority,
        () =>
          opApply('click', { selector: '#submit', retry: { maxRetries: 5 } }, runtime, {}, resolve)
      )
    ).rejects.toThrow('EXTERNAL_RESULT_UNVERIFIED');
    expect(page.click).toHaveBeenCalledTimes(1);
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'unknown' }) })
    );
  });

  it('executes the exact resolved target that admission reviewed', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    let selector = '#reviewed';
    await withExternalOperationAuthority(
      () => {
        selector = '#changed';
        return authority;
      },
      () =>
        opApply('click', { selector: '{{target}}' }, runtime, {}, (value: unknown) =>
          value === '{{target}}' ? selector : value
        )
    );
    expect(page.click).toHaveBeenCalledWith('#reviewed', expect.any(Object));
  });

  it('rejects a page change between admission and execution', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    await expect(
      withExternalOperationAuthority(
        () => {
          vi.mocked(page.url).mockReturnValue('https://example.com/changed');
          return authority;
        },
        () => opApply('click', { selector: '#submit' }, runtime, {}, resolve)
      )
    ).rejects.toThrow('BROWSER_TARGET_CHANGED');
    expect(page.click).not.toHaveBeenCalled();
  });

  it('does not try another fill strategy after attempting the first fill', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    vi.mocked(page.fill).mockRejectedValue(new Error('fill timeout'));
    await expect(
      withExternalOperationAuthority(
        () => authority,
        () => opApply('fill', { selector: 'Email', text: 'value' }, runtime, {}, resolve)
      )
    ).rejects.toThrow('EXTERNAL_RESULT_UNVERIFIED');
    expect(page.fill).toHaveBeenCalledTimes(1);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('retains secret and missing-ref floors after admission', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    await expect(
      withExternalOperationAuthority(
        () => authority,
        () =>
          opApply('fill_secret_ref', { ref: '@e1', secret_ref: 'MISSING' }, runtime, {}, resolve)
      )
    ).rejects.toThrow('BROWSER_SECRET_MISSING');
    await expect(
      withExternalOperationAuthority(
        () => authority,
        () => opApply('click_ref', { ref: '@missing' }, runtime, {}, resolve)
      )
    ).rejects.toThrow('Unknown browser ref');
    expect(page.fill).not.toHaveBeenCalled();
    expect(page.click).not.toHaveBeenCalled();
  });

  it('gates tab-opening controls before creating the tab', async () => {
    await expect(
      opControl('open_tab', { url: 'https://example.com' }, runtime, {}, vi.fn(), resolve)
    ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(runtime.context.newPage).not.toHaveBeenCalled();
  });

  it('rejects multi-mutation batches before browser launch and counts nested effects', async () => {
    const steps = [
      { type: 'apply' as const, op: 'click', params: { selector: '#a' } },
      { type: 'capture' as const, op: 'goto', params: { url: 'https://example.com' } },
    ];
    await expect(
      withExternalOperationPipelineRun('run', () => executePipeline(steps, 'session', {}))
    ).rejects.toThrow('EXTERNAL_BATCH_CHECKPOINT_REQUIRED');
    expect(
      countBrowserExternalEffects([{ type: 'control', op: 'if', params: { then: steps } }])
    ).toBe(2);
    expect(
      countBrowserExternalEffects([{ type: 'control', op: 'while', params: { pipeline: steps } }])
    ).toBe(Infinity);
    expect(enforceApprovalGate).not.toHaveBeenCalled();
  });

  it('rejects uncheckpointed multi-action assist before snapshot or model calls', async () => {
    const executePipeline = vi.fn();
    await expect(
      withExternalOperationPipelineRun('run', () =>
        runBrowserAssist(
          { goal: 'Read the form', max_actions: 2, allowed_origins: ['https://example.com'] },
          { executePipeline }
        )
      )
    ).rejects.toThrow('EXTERNAL_BATCH_CHECKPOINT_REQUIRED');
    expect(executePipeline).not.toHaveBeenCalled();
  });

  it('allows one-effect exclusive branches and loops explicitly bounded to one iteration', () => {
    const click = { type: 'apply', op: 'click', params: { selector: '#submit' } };
    const branch = [{ type: 'control', op: 'if', params: { then: [click], else: [click] } }];
    expect(countBrowserExternalEffects(branch)).toBe(1);
    expect(() =>
      withExternalOperationPipelineRun('run', () =>
        assertExternalOperationBatchResumable(() => countBrowserExternalEffects(branch))
      )
    ).not.toThrow();
    expect(
      countBrowserExternalEffects([
        { type: 'control', op: 'while', params: { pipeline: [click], max_iterations: 1 } },
      ])
    ).toBe(1);
    expect(
      countBrowserExternalEffects([
        { type: 'control', op: 'while', params: { pipeline: [click], max_iterations: 0 } },
      ])
    ).toBe(0);
    expect(
      countBrowserExternalEffects([
        { type: 'control', op: 'while', params: { pipeline: [click], max_iterations: 2 } },
      ])
    ).toBe(Infinity);
    expect(
      countBrowserExternalEffects([
        {
          type: 'control',
          op: 'while',
          params: { pipeline: [click], max_iterations: '{{limit}}' },
        },
      ])
    ).toBe(Infinity);
  });
});
