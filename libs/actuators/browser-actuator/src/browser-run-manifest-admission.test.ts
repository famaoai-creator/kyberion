import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';

// Real admission path: runBrowserMutation → runExternalOperation → runtime
// authority → run-manifest charter → approval gate. Only storage side effects
// and the scope source are stubbed.
vi.mock('@agent/core/scope-envelope', () => ({
  currentScopeEnvelope: vi.fn(() => undefined),
  runtimeScopeIdentity: vi.fn(() => ({ tier: 'confidential', tenant_slug: 'acme' })),
}));
vi.mock('@agent/core/scope-context', async (original) => ({
  ...(await original<typeof import('@agent/core/scope-context')>()),
  resolveScopeContext: vi.fn(() => ({ tenant_slug: 'acme', tier: 'confidential' })),
}));
vi.mock('@agent/core/workforce/artifact-store', () => ({
  writeScopedArtifact: vi.fn(() => ({ repo_relative_path: 'active/shared/artifacts/review.json' })),
}));
vi.mock('@agent/core/organization/onboarding-runtime-identity', () => ({
  inspectInstalledOnboardingRuntime: vi.fn(() => ({ ready: false })),
}));
vi.mock('@agent/core/governance/audit-chain', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('@agent/core/governance/external-operation-store', async (original) => ({
  ...(await original<typeof import('@agent/core/governance/external-operation-store')>()),
  reserveExternalOperation: vi.fn(),
  persistExternalOperationOutcome: vi.fn(),
}));
vi.mock('@agent/core/governance/approval-gate', async (original) => {
  const actual = await original<typeof import('@agent/core/governance/approval-gate')>();
  return {
    ...actual,
    enforceApprovalGate: vi.fn((params: Parameters<typeof actual.enforceApprovalGate>[0]) =>
      params.charter
        ? actual.enforceApprovalGate(params)
        : { allowed: false, status: 'pending', message: 'per-step approval required' }
    ),
  };
});

import * as pathResolver from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { enforceApprovalGate } from '@agent/core/governance/approval-gate';
import { compileRunManifest } from '@agent/core/pipeline/run-manifest';
import { runManifestGrantsFor } from '@agent/core/governance/external-operation-runtime';
import {
  charterDir,
  recordRunManifestRunStarted,
} from '@agent/core/governance/accountability-charter-registry';
import type { Charter } from '@agent/core/governance/accountability-charter';
import { ExternalOperationApprovalRequired } from '@agent/core/governance/external-operation';
import {
  withRunManifestBinding,
  withRunManifestStep,
  withRuntimeExternalOperationAuthority,
} from '@agent/core/governance/external-operation-runtime';
import { runBrowserMutation } from './browser-external-governance.js';
import { createBrowserWatchdog } from './browser-watchdog.js';
import type { BrowserRuntime } from './browser-pipeline-helpers.js';

const PAGE = 'https://g.example.com/cgi-bin/x';
const STEPS = [
  { op: 'secret:get', params: { service: 'garoon', account: 'user', export_as: 'pw' } },
  { op: 'browser:goto', params: { url: PAGE } },
  { op: 'browser:evaluate', params: { script: '(() => document.title)()' } },
  { op: 'browser:fill', params: { selector: '#password', text: '{{pw}}' } },
];
const manifest = compileRunManifest(STEPS, {
  inputPath: 'knowledge/confidential/acme/scenarios/run.json',
  contentSha256: 'c'.repeat(64),
  scope: { tier: 'confidential', tenantSlug: 'acme' },
});
const SCOPE = {
  kind: 'run_manifest',
  tenant_slug: 'acme',
  manifest_hash: manifest.manifest_hash,
} as const;

describe('run manifest admission through runBrowserMutation', () => {
  let root = '';
  let rootDir = '';
  let page: Page;
  let runtime: BrowserRuntime;
  let currentUrl = PAGE;

  const mutate = (entryId: string, op: string, params: Record<string, unknown>) => {
    const execute = vi.fn(async () => 'done');
    const result = withRunManifestBinding(
      {
        manifest,
        charterId: 'rm-browser-charter',
        principal: 'attended',
        runId: 'run-1',
        pathOptions: { rootDir },
      },
      () =>
        withRuntimeExternalOperationAuthority(
          { runId: 'run-1', stepId: entryId, hasHuman: true },
          () =>
            withRunManifestStep({ entryId }, () =>
              runBrowserMutation(
                {
                  op,
                  params,
                  runtime,
                  page,
                  // In-actuator template resolution (browser-internal body).
                  resolve: (value: unknown) => (value === '{{pw}}' ? 'hunter2' : value),
                },
                execute
              )
            )
        )
    );
    return { result, execute };
  };

  beforeAll(() => {
    root = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `rm-browser-${randomUUID()}`
    );
  });
  afterAll(() => {
    if (root) safeRmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    currentUrl = PAGE;
    rootDir = path.join(root, randomUUID());
    const grants = runManifestGrantsFor(manifest);
    const charter: Charter = {
      charter_id: 'rm-browser-charter',
      scope: SCOPE,
      accountable: {
        actor: 'user:rmowner',
        authority_basis: { kind: 'owner', evidence_ref: 'approval:project-trust/req-1' },
        accepted_at: '2026-11-20T00:00:00.000Z',
        expires_at: '2099-01-01T00:00:00.000Z',
        statement_sha256: 'a'.repeat(64),
        deputies: [],
      },
      envelope: {
        manifest_operations: grants,
        principal_modes: ['attended'],
        money: { currency: 'JPY', per_action: 0, per_day: 0, per_month: 0 },
        data_tier: { read: ['confidential:acme'], write: [] },
        external_effects: {},
        irreversible: 'named_actions_only',
        irreversible_named_actions: [...new Set(grants.map((grant) => grant.operation_id))],
      },
      appetite: {
        max_loss_per_incident: 0,
        reputational_class_max: 'B',
        blast_radius_max: { recipients: 1, systems: 1 },
        tripwires: ['manual-stop'],
      },
    };
    const dir = charterDir(SCOPE, { rootDir });
    safeMkdir(dir, { recursive: true });
    safeWriteFile(path.join(dir, `${charter.charter_id}.json`), JSON.stringify(charter));
    // The runner records each bound run (and its daily cap) before any step.
    recordRunManifestRunStarted(
      charter,
      { run_id: 'run-1', principal_mode: 'attended' },
      { rootDir }
    );
    page = { url: vi.fn(() => currentUrl) } as unknown as Page;
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

  it('runs an approved page script and a secret fill without any approval request', async () => {
    const evaluate = mutate('2', 'evaluate', { ...STEPS[2].params });
    await expect(evaluate.result).resolves.toBe('done');
    expect(evaluate.execute).toHaveBeenCalledTimes(1);
    const fill = mutate('3', 'fill', { ...STEPS[3].params });
    await expect(fill.result).resolves.toBe('done');
    expect(vi.mocked(enforceApprovalGate).mock.calls.every(([params]) => params.charter)).toBe(
      true
    );
  });

  it('asks per step when the approved script would run on a redirected origin', async () => {
    currentUrl = 'https://evil.example/landing';
    const evaluate = mutate('2', 'evaluate', { ...STEPS[2].params });
    await expect(evaluate.result).rejects.toBeInstanceOf(ExternalOperationApprovalRequired);
    expect(evaluate.execute).not.toHaveBeenCalled();
    expect(vi.mocked(enforceApprovalGate).mock.calls.at(-1)?.[0].charter).toBeUndefined();
  });
});
