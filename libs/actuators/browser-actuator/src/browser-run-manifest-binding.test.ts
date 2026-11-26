import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';

// Capture the exact effect the runtime builds instead of admitting it.
vi.mock('@agent/core/governance/external-operation', () => ({
  runExternalOperation: vi.fn(async (_input: unknown, execute: () => Promise<unknown>) =>
    execute()
  ),
}));
vi.mock('@agent/core/scope-envelope', () => ({ currentScopeEnvelope: vi.fn(() => undefined) }));
vi.mock('@agent/core/scope-context', async (original) => ({
  ...(await original<typeof import('@agent/core/scope-context')>()),
  resolveScopeContext: vi.fn(() => ({ tenant_slug: 'acme', tier: 'confidential' })),
}));

import { runExternalOperation } from '@agent/core/governance/external-operation';
import { compileRunManifest, runtimeShapedAuthoredParams } from '@agent/core/pipeline/run-manifest';
import {
  runManifestGrantsFor,
  verifyManifestEntryMatchesEffect,
} from '@agent/core/governance/external-operation-runtime';
import { browserOperationRequiresAdmission as coreClassifier } from '@agent/core/foundation/authorization-registry';
import {
  browserOperationRequiresAdmission,
  runBrowserMutation,
} from './browser-external-governance.js';
import { createBrowserWatchdog } from './browser-watchdog.js';
import type { BrowserRuntime } from './browser-pipeline-helpers.js';

const STEPS = [
  { op: 'secret:get', params: { service: 'garoon', account: 'user', export_as: 'pw' } },
  { op: 'browser:goto', params: { url: 'https://g.example.com/cgi-bin/x', waitUntil: 'load' } },
  {
    op: 'browser:evaluate',
    params: { script: '(() => document.title)()', export_as: 'title' },
  },
  { op: 'browser:fill', params: { selector: '#password', text: '{{pw}}' } },
];

const manifest = compileRunManifest(STEPS, {
  inputPath: 'knowledge/confidential/acme/scenarios/x.json',
  contentSha256: 'c'.repeat(64),
  scope: { tier: 'confidential', tenantSlug: 'acme' },
});
const grants = runManifestGrantsFor(manifest);

let page: Page;
let runtime: BrowserRuntime;

async function capturedEffect(
  op: string,
  params: Record<string, unknown>,
  resolve: (value: unknown) => unknown = (value) => value
): Promise<Record<string, unknown>> {
  vi.mocked(runExternalOperation).mockClear();
  await runBrowserMutation({ op, params, runtime, page, resolve }, async () => 'done');
  const input = vi.mocked(runExternalOperation).mock.calls[0][0] as {
    effect: Record<string, unknown>;
  };
  return input.effect;
}

describe('run manifest ↔ browser runtime effect binding', () => {
  beforeEach(() => {
    page = { url: vi.fn(() => 'https://g.example.com/cgi-bin/x') } as unknown as Page;
    runtime = {
      tabs: new Map([['tab-1', page]]),
      activeTabId: 'tab-1',
      context: { newPage: vi.fn() },
      pageIds: new WeakMap(),
      cdpSessions: new WeakMap(),
      watchdog: createBrowserWatchdog(),
      consoleEvents: [],
      networkEvents: [],
      navigationPolicy: { allowed_origins: ['https://g.example.com'] },
    } as unknown as BrowserRuntime;
  });

  it('keeps one admission classifier shared by core and the browser package', () => {
    expect(browserOperationRequiresAdmission).toBe(coreClassifier);
  });

  it('hashes static authored params exactly as the runtime binds requested_params', async () => {
    for (const [index, op] of [
      [1, 'goto'],
      [2, 'evaluate'],
    ] as const) {
      const step = STEPS[index];
      const effectBody = await capturedEffect(op, { ...step.params });
      const entry = manifest.requirements.effects.find((e) => e.entry_id === String(index))!;
      const grant = grants.find((g) => g.entry_id === String(index))!;
      expect(entry.params_template_hash).toBe(
        (await import('@agent/core/governance/approval-presentation')).computeApprovalPayloadHash(
          effectBody.requested_params as Record<string, unknown>
        )
      );
      expect(
        verifyManifestEntryMatchesEffect(grant, effectBody, {
          operationId: `browser:${op}`,
          occurrence: 1,
        })
      ).toEqual({ ok: true });
    }
  });

  it('binds an in-actuator resolved template by its authored params', async () => {
    // Browser-internal bodies resolve templates inside runBrowserMutation:
    // requested_params keeps the authored template, params carries the value.
    const effectBody = await capturedEffect('fill', { ...STEPS[3].params }, (value) =>
      value === '{{pw}}' ? 'hunter2' : value
    );
    expect(effectBody.requested_params).toEqual(STEPS[3].params);
    expect(effectBody.params).toEqual({ selector: '#password', text: 'hunter2' });
    const grant = grants.find((g) => g.entry_id === '3')!;
    expect(
      verifyManifestEntryMatchesEffect(grant, effectBody, {
        operationId: 'browser:fill',
        occurrence: 1,
      })
    ).toEqual({ ok: true });
  });

  it('binds a runner-resolved template only with the authored params', async () => {
    // The pipeline runner resolves templates before dispatch, so the runtime
    // sees the value in requested_params; the authored template must be carried.
    const effectBody = await capturedEffect('fill', { selector: '#password', text: 'hunter2' });
    const grant = grants.find((g) => g.entry_id === '3')!;
    expect(
      verifyManifestEntryMatchesEffect(grant, effectBody, {
        operationId: 'browser:fill',
        occurrence: 1,
      }).ok
    ).toBe(false);
    expect(
      verifyManifestEntryMatchesEffect(grant, effectBody, {
        operationId: 'browser:fill',
        occurrence: 1,
        authoredParams: runtimeShapedAuthoredParams('browser:fill', STEPS[3]),
      })
    ).toEqual({ ok: true });
  });
});
