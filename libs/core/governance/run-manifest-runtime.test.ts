import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../scope-context.js', () => ({
  resolveScopeContext: vi.fn(() => ({ tier: 'confidential', tenant_slug: 'acme' })),
}));
vi.mock('../scope-envelope.js', () => ({
  currentScopeEnvelope: vi.fn(() => undefined),
  runtimeScopeIdentity: vi.fn(() => ({ tier: 'confidential', tenant_slug: 'acme' })),
}));
vi.mock('../workforce/artifact-store.js', () => ({
  writeScopedArtifact: vi.fn(() => ({
    repo_relative_path: 'active/shared/artifacts/confidential/acme/review.json',
  })),
}));
vi.mock('../organization/onboarding-runtime-identity.js', () => ({
  inspectInstalledOnboardingRuntime: vi.fn(() => ({ ready: false })),
}));
vi.mock('./audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('./external-operation-store.js', async (original) => ({
  ...(await original<typeof import('./external-operation-store.js')>()),
  reserveExternalOperation: vi.fn(),
  persistExternalOperationOutcome: vi.fn(),
}));
// The real gate decides every charter-bearing admission; a call without a
// charter is per-step approval, answered as "pending" without a store write.
vi.mock('./approval-gate.js', async (original) => {
  const actual = await original<typeof import('./approval-gate.js')>();
  return {
    ...actual,
    enforceApprovalGate: vi.fn((params: Parameters<typeof actual.enforceApprovalGate>[0]) =>
      params.charter
        ? actual.enforceApprovalGate(params)
        : { allowed: false, status: 'pending', message: 'per-step approval required' }
    ),
  };
});

import * as pathResolver from '../path-resolver.js';
import { resolveScopeContext } from '../scope-context.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { writeScopedArtifact } from '../workforce/artifact-store.js';
import { auditChain } from './audit-chain.js';
import { enforceApprovalGate } from './approval-gate.js';
import { reserveExternalOperation } from './external-operation-store.js';
import { compileRunManifest, runtimeShapedAuthoredParams } from '../pipeline/run-manifest.js';
import { runManifestGrantsFor, type RunPrincipalMode } from './run-manifest-grant.js';
import type { Charter } from './accountability-charter.js';
import {
  charterDir,
  readCharterLedger,
  recordRunManifestRunStarted,
  recordTripwire,
  retireCharter,
} from './accountability-charter-registry.js';
import { humanActor } from '../contracts/actor.js';
import {
  ExternalOperationApprovalRequired,
  runExternalOperation,
  type ExternalOperation,
} from './external-operation.js';
import {
  withRunManifestBinding,
  withRunManifestStep,
  withRuntimeExternalOperationAuthority,
} from './external-operation-runtime.js';

const PAGE = 'https://g.example.com/cgi-bin/x';
const STEPS = [
  { op: 'secret:get', params: { service: 'garoon', account: 'user', export_as: 'pw' } },
  { op: 'browser:goto', params: { url: PAGE } },
  { op: 'browser:evaluate', params: { script: '(() => document.title)()', export_as: 'title' } },
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

function seedCharter(
  rootDir: string,
  modes: RunPrincipalMode[] = ['attended'],
  options: { recordRun?: boolean } = {}
): Charter {
  const grants = runManifestGrantsFor(manifest);
  const charter: Charter = {
    charter_id: 'rm-test-charter',
    scope: SCOPE,
    accountable: {
      actor: 'user:rmowner',
      authority_basis: { kind: 'owner', evidence_ref: 'approval:project-trust/req-1' },
      accepted_at: '2026-11-20T00:00:00.000Z',
      expires_at: '2027-02-01T00:00:00.000Z',
      statement_sha256: 'a'.repeat(64),
      deputies: [],
    },
    envelope: {
      manifest_operations: grants,
      principal_modes: modes,
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
  safeWriteFile(path.join(dir, `${charter.charter_id}.json`), JSON.stringify(charter, null, 2));
  // The runner records each bound run (and its daily cap) before any step.
  if (options.recordRun !== false)
    recordRunManifestRunStarted(
      charter,
      { run_id: 'run-1', principal_mode: modes[0] },
      { rootDir }
    );
  return charter;
}

/** The effect shape runBrowserMutation hands to runExternalOperation. */
function browserOperation(
  op: 'goto' | 'evaluate' | 'fill',
  params: Record<string, unknown>,
  currentUrl = PAGE,
  requested: Record<string, unknown> = params
): ExternalOperation {
  return {
    operationId: `browser:${op}`,
    tenantSlug: resolveScopeContext().tenant_slug,
    effect: {
      session_scope: 'scope-fingerprint',
      tab_id: 'tab-1',
      current_url: currentUrl,
      requested_params: structuredClone(requested),
      params: structuredClone(params),
    },
    requiresApproval: true,
    delegable: false,
  };
}

describe('run-manifest charter at the external-operation gate', () => {
  let root = '';
  let rootDir = '';
  let charter: Charter;

  const run = (
    entryId: string,
    operation: ExternalOperation,
    options: {
      principal?: RunPrincipalMode;
      bind?: boolean;
      step?: boolean;
      authoredParams?: Record<string, unknown>;
      charterId?: string;
      /**
       * Install the binding with the clock at this instant (fake Date), then
       * move the clock back to the real now before the step runs.
       */
      bindClockAt?: Date;
    } = {}
  ) => {
    const leaf = () =>
      withRuntimeExternalOperationAuthority(
        { runId: 'run-1', stepId: entryId, hasHuman: true },
        () =>
          options.step === false
            ? runExternalOperation(
                operation,
                async () => 'done',
                () => 'succeeded'
              )
            : withRunManifestStep(
                {
                  entryId,
                  ...(options.authoredParams ? { authoredParams: options.authoredParams } : {}),
                },
                () =>
                  runExternalOperation(
                    operation,
                    async () => 'done',
                    () => 'succeeded'
                  )
              )
      );
    if (options.bind === false) return leaf();
    const stepClock = Date.now();
    if (options.bindClockAt) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(options.bindClockAt);
    }
    return withRunManifestBinding(
      {
        manifest,
        charterId: options.charterId ?? charter.charter_id,
        principal: options.principal ?? 'attended',
        runId: 'run-1',
        pathOptions: { rootDir },
      },
      () => {
        if (options.bindClockAt) vi.setSystemTime(stepClock);
        return leaf();
      }
    );
  };

  const expectPerStepApproval = async (promise: Promise<unknown>) => {
    await expect(promise).rejects.toBeInstanceOf(ExternalOperationApprovalRequired);
    const params = vi.mocked(enforceApprovalGate).mock.calls.at(-1)?.[0];
    expect(params?.charter).toBeUndefined();
  };

  beforeAll(() => {
    root = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `rm-runtime-${randomUUID()}`
    );
  });
  afterAll(() => {
    if (root) safeRmSync(root, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveScopeContext).mockReturnValue({ tier: 'confidential', tenant_slug: 'acme' });
    rootDir = path.join(root, randomUUID());
    charter = seedCharter(rootDir);
  });

  it('admits an approved evaluate with zero approvals and keeps every per-step record', async () => {
    const step = STEPS[2];
    const authored = runtimeShapedAuthoredParams('browser:evaluate', step);
    await expect(run('2', browserOperation('evaluate', authored))).resolves.toBe('done');

    const gate = vi.mocked(enforceApprovalGate).mock.calls.at(-1)![0];
    expect(gate.charter?.scope).toEqual(SCOPE);
    expect(gate.charter?.action).toMatchObject({
      action_class: 'run_manifest_operation',
      manifest_operation: {
        manifest_hash: manifest.manifest_hash,
        entry_id: '2',
        operation_id: 'browser:evaluate',
        principal_mode: 'attended',
      },
      actor: { kind: 'agent', on_behalf_of: 'user:rmowner' },
    });
    // Review artifact, durable reservation, charter ledger and audit stay per step.
    expect(writeScopedArtifact).toHaveBeenCalledTimes(1);
    expect(reserveExternalOperation).toHaveBeenCalledTimes(1);
    const ledger = readCharterLedger(charter, { rootDir }).map((entry) => entry.kind);
    expect(ledger).toEqual([
      'run_started',
      'consumption',
      'execution_started',
      'execution_outcome',
    ]);
    const audits = vi.mocked(auditChain.record).mock.calls.map(([entry]) => entry);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'approval_gate', result: 'allowed' }),
        expect.objectContaining({
          action: 'external_operation_outcome',
          operation: 'browser:evaluate',
          result: 'allowed',
        }),
      ])
    );
  });

  it('admits navigation to the approved URL and a secret typed on the approved origin', async () => {
    await expect(run('1', browserOperation('goto', { url: PAGE }, 'about:blank'))).resolves.toBe(
      'done'
    );
    // Runner-resolved secret: the effect carries the value, the step its template.
    const fill = browserOperation('fill', { selector: '#password', text: 'hunter2' });
    await expect(
      run('3', fill, {
        authoredParams: runtimeShapedAuthoredParams('browser:fill', STEPS[3]),
      })
    ).resolves.toBe('done');
  });

  it('falls back to per-step approval without a run binding', async () => {
    const authored = runtimeShapedAuthoredParams('browser:evaluate', STEPS[2]);
    await expectPerStepApproval(run('2', browserOperation('evaluate', authored), { bind: false }));
  });

  it('falls back to per-step approval when the run was never recorded (daily cap skipped)', async () => {
    rootDir = path.join(root, randomUUID());
    charter = seedCharter(rootDir, ['attended'], { recordRun: false });
    const authored = runtimeShapedAuthoredParams('browser:evaluate', STEPS[2]);
    await expectPerStepApproval(run('2', browserOperation('evaluate', authored)));
  });

  it('falls back to per-step approval when the run id was recorded on an earlier UTC day', async () => {
    rootDir = path.join(root, randomUUID());
    charter = seedCharter(rootDir, ['attended'], { recordRun: false });
    recordRunManifestRunStarted(
      charter,
      { run_id: 'run-1', principal_mode: 'attended' },
      { rootDir },
      new Date(Date.now() - 86_400_000)
    );
    const authored = runtimeShapedAuthoredParams('browser:evaluate', STEPS[2]);
    await expectPerStepApproval(run('2', browserOperation('evaluate', authored)));
  });

  it("ignores a caller-supplied bind time (no reuse of an earlier day's run id)", async () => {
    rootDir = path.join(root, randomUUID());
    charter = seedCharter(rootDir, ['attended'], { recordRun: false });
    const yesterday = new Date(Date.now() - 86_400_000);
    recordRunManifestRunStarted(
      charter,
      { run_id: 'run-1', principal_mode: 'attended' },
      { rootDir },
      yesterday
    );
    const authored = runtimeShapedAuthoredParams('browser:evaluate', STEPS[2]);
    // A trusted in-process caller claiming the binding was installed yesterday.
    await expectPerStepApproval(
      withRunManifestBinding(
        {
          manifest,
          charterId: charter.charter_id,
          principal: 'attended',
          runId: 'run-1',
          pathOptions: { rootDir },
          boundAt: yesterday,
        } as Parameters<typeof withRunManifestBinding>[0],
        () =>
          withRuntimeExternalOperationAuthority(
            { runId: 'run-1', stepId: '2', hasHuman: true },
            () =>
              withRunManifestStep({ entryId: '2', authoredParams: authored }, () =>
                runExternalOperation(
                  browserOperation('evaluate', authored),
                  async () => 'done',
                  () => 'succeeded'
                )
              )
          )
      )
    );
  });

  it('keeps pre-approval for a run recorded and bound before UTC midnight', async () => {
    const todayStart = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate()
    );
    const authored = runtimeShapedAuthoredParams('browser:evaluate', STEPS[2]);
    // Recorded at 23:50 and bound at 23:59 yesterday; the first external step is today.
    rootDir = path.join(root, randomUUID());
    charter = seedCharter(rootDir, ['attended'], { recordRun: false });
    recordRunManifestRunStarted(
      charter,
      { run_id: 'run-1', principal_mode: 'attended' },
      { rootDir },
      new Date(todayStart - 600_000)
    );
    await expect(
      run('2', browserOperation('evaluate', authored), {
        authoredParams: authored,
        bindClockAt: new Date(todayStart - 30_000),
      })
    ).resolves.toBe('done');
    // Recorded a moment before midnight, bound a moment after it.
    rootDir = path.join(root, randomUUID());
    charter = seedCharter(rootDir, ['attended'], { recordRun: false });
    recordRunManifestRunStarted(
      charter,
      { run_id: 'run-1', principal_mode: 'attended' },
      { rootDir },
      new Date(todayStart - 500)
    );
    await expect(
      run('2', browserOperation('evaluate', authored), {
        authoredParams: authored,
        bindClockAt: new Date(todayStart + 200),
      })
    ).resolves.toBe('done');
  });

  it('falls back to per-step approval without a current step', async () => {
    const authored = runtimeShapedAuthoredParams('browser:evaluate', STEPS[2]);
    await expectPerStepApproval(run('2', browserOperation('evaluate', authored), { step: false }));
  });

  it('falls back to per-step approval when the params differ from the approved step', async () => {
    await expectPerStepApproval(
      run('2', browserOperation('evaluate', { script: 'fetch("https://x.example")' }))
    );
  });

  it('falls back to per-step approval for a page on a foreign origin', async () => {
    const authored = runtimeShapedAuthoredParams('browser:evaluate', STEPS[2]);
    await expectPerStepApproval(
      run('2', browserOperation('evaluate', authored, 'https://evil.example/landing'))
    );
  });

  it('falls back to per-step approval for a secret on a foreign origin', async () => {
    const fill = browserOperation(
      'fill',
      { selector: '#password', text: 'hunter2' },
      'https://evil.example/login'
    );
    await expectPerStepApproval(
      run('3', fill, { authoredParams: runtimeShapedAuthoredParams('browser:fill', STEPS[3]) })
    );
  });

  it('falls back to per-step approval past the occurrence bound', async () => {
    const authored = runtimeShapedAuthoredParams('browser:evaluate', STEPS[2]);
    await withRunManifestBinding(
      {
        manifest,
        charterId: charter.charter_id,
        principal: 'attended',
        runId: 'run-1',
        pathOptions: { rootDir },
      },
      async () => {
        const once = () =>
          withRuntimeExternalOperationAuthority(
            { runId: 'run-1', stepId: '2', hasHuman: true },
            () =>
              withRunManifestStep({ entryId: '2' }, () =>
                runExternalOperation(
                  browserOperation('evaluate', authored),
                  async () => 'done',
                  () => 'succeeded'
                )
              )
          );
        await expect(once()).resolves.toBe('done');
        await expectPerStepApproval(once());
      }
    );
  });

  it('falls back to per-step approval for an unattended run of an attended-only charter', async () => {
    const authored = runtimeShapedAuthoredParams('browser:evaluate', STEPS[2]);
    await expectPerStepApproval(
      run('2', browserOperation('evaluate', authored), { principal: 'unattended' })
    );
  });

  it('admits an unattended run only when the approver enabled it', async () => {
    rootDir = path.join(root, randomUUID());
    charter = seedCharter(rootDir, ['attended', 'unattended']);
    const authored = runtimeShapedAuthoredParams('browser:evaluate', STEPS[2]);
    await expect(
      run('2', browserOperation('evaluate', authored), { principal: 'unattended' })
    ).resolves.toBe('done');
  });

  it('falls back to per-step approval when the trusted tenant differs', async () => {
    vi.mocked(resolveScopeContext).mockReturnValue({ tier: 'confidential', tenant_slug: 'other' });
    const authored = runtimeShapedAuthoredParams('browser:evaluate', STEPS[2]);
    await expectPerStepApproval(run('2', browserOperation('evaluate', authored)));
  });

  it('falls back to per-step approval when the bound charter is no longer in force', async () => {
    retireCharter(charter, humanActor('rmowner'), 'stop', { rootDir });
    const authored = runtimeShapedAuthoredParams('browser:evaluate', STEPS[2]);
    await expectPerStepApproval(run('2', browserOperation('evaluate', authored)));
    await expectPerStepApproval(
      run('2', browserOperation('evaluate', authored), { charterId: 'rm-other' })
    );
  });

  it('ignores a run-manifest charter offered by an authority the binding did not verify', async () => {
    const authored = runtimeShapedAuthoredParams('browser:evaluate', STEPS[2]);
    const forged = browserOperation('evaluate', authored);
    forged.authority = {
      agentId: 'pipeline-external-worker',
      tenantSlug: 'acme',
      invocationId: 'forged',
      hasHuman: true,
      charter: {
        scope: SCOPE,
        action: {
          actor: {
            kind: 'agent',
            id: 'kyberion://agent/acme/_/pipeline-runner',
            on_behalf_of: 'user:rmowner',
          },
          action_class: 'run_manifest_operation',
          manifest_operation: {
            manifest_hash: manifest.manifest_hash,
            entry_id: '2',
            operation_id: 'browser:evaluate',
            principal_mode: 'attended',
          },
          reversible: false,
        },
        pathOptions: { rootDir },
      },
    };
    await expectPerStepApproval(
      runExternalOperation(
        forged,
        async () => 'done',
        () => 'succeeded'
      )
    );
  });

  it('still stops on the charter tripwire', async () => {
    recordTripwire(charter, 'manual-stop', 'operator stop', { rootDir });
    const authored = runtimeShapedAuthoredParams('browser:evaluate', STEPS[2]);
    await expect(run('2', browserOperation('evaluate', authored))).rejects.toThrow(/CHARTER_STOP/);
    expect(vi.mocked(enforceApprovalGate).mock.calls.at(-1)?.[0].charter?.scope).toEqual(SCOPE);
  });
});
