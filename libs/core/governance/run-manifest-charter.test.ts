import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./approval-store-reader.js', async (original) => ({
  ...(await original<typeof import('./approval-store-reader.js')>()),
  loadApprovalRequest: vi.fn(),
}));
vi.mock('../project/project-trust.js', async (original) => ({
  ...(await original<typeof import('../project/project-trust.js')>()),
  assertProjectTrustApproval: vi.fn(),
}));

import * as pathResolver from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { loadApprovalRequest } from './approval-store-reader.js';
import { assertProjectTrustApproval } from '../project/project-trust.js';
import {
  computeApprovalPayloadHash,
  computeApprovalPresentedDigest,
} from './approval-presentation.js';
import type { ApprovalRequestRecord } from './approval-store.js';
import { compileRunManifest } from '../pipeline/run-manifest.js';
import {
  projectTrustBindingPayloadV1,
  projectTrustBindingPayloadV2,
  projectTrustEffectBinding,
  projectTrustRequestedEffects,
} from '../project/project-trust-binding.js';
import {
  DEFAULT_RUN_MANIFEST_RUNS_PER_DAY,
  runManifestGrantsFor,
  type RunPrincipalMode,
} from './run-manifest-grant.js';
import {
  findActiveCharter,
  readCharterLedger,
  readRunManifestRunUsage,
  recordRunManifestRunStarted,
} from './accountability-charter-registry.js';
import { ensureRunManifestCharter, runManifestApprovalRunUsage } from './run-manifest-charter.js';

const NOW = new Date('2026-11-25T09:00:00.000Z');
const DECIDED_AT = '2026-11-24T09:00:00.000Z';
const INPUT = 'knowledge/confidential/acme/scenarios/run.json';
const CONTENT = 'c'.repeat(64);
const STEPS = [
  { op: 'secret:get', params: { service: 'garoon', account: 'user', export_as: 'pw' } },
  { op: 'browser:goto', params: { url: 'https://g.example.com/cgi-bin/x' } },
  { op: 'browser:fill', params: { selector: '#password', text: '{{pw}}' } },
  { op: 'browser:evaluate', params: { script: '(() => document.title)()' } },
];
const manifest = compileRunManifest(STEPS, {
  inputPath: INPUT,
  contentSha256: CONTENT,
  scope: { tier: 'confidential', tenantSlug: 'acme' },
});

function trustRecord(
  overrides: Partial<ApprovalRequestRecord> = {},
  options: {
    modes?: RunPrincipalMode[];
    v1?: boolean;
    manifestHash?: string;
    runsPerDay?: number;
  } = {}
): ApprovalRequestRecord {
  const binding = {
    manifest_hash: options.manifestHash ?? manifest.manifest_hash,
    principal_modes: options.modes ?? (['attended'] as RunPrincipalMode[]),
    ...(options.runsPerDay !== undefined ? { runs_per_day: options.runsPerDay } : {}),
  };
  const record: ApprovalRequestRecord = {
    id: 'req-1',
    kind: 'channel-approval',
    storageChannel: 'project-trust',
    channel: 'project-trust',
    threadTs: projectTrustEffectBinding(INPUT),
    correlationId: projectTrustEffectBinding(INPUT),
    requestedBy: 'pipeline-cli',
    requestedAt: '2026-11-24T08:00:00.000Z',
    title: `Approve project-local pipeline: ${INPUT}`,
    summary: 'Runs 3 external operations on 1 site',
    details: 'Open https://g.example.com/cgi-bin/x once',
    severity: 'high',
    requestedByContext: {
      surface: 'terminal',
      actorId: 'pipeline-cli',
      actorRole: 'project-trust',
    },
    justification: {
      reason: 'trust',
      requestedEffects: projectTrustRequestedEffects(INPUT, options.v1 ? undefined : binding),
    },
    accountability: {
      finalDecision: 'human_only',
      payloadHash: computeApprovalPayloadHash(
        options.v1
          ? projectTrustBindingPayloadV1(INPUT, CONTENT)
          : projectTrustBindingPayloadV2(INPUT, CONTENT, binding)
      ),
      effectBinding: projectTrustEffectBinding(INPUT),
    },
    status: 'approved',
    decidedAt: DECIDED_AT,
    decidedBy: 'user:rmowner',
    decidedByType: 'human',
    authenticated: true,
    decidedAuthMethod: 'terminal_attested',
    ...overrides,
  };
  if (!('verifiedPresentedDigest' in overrides))
    record.verifiedPresentedDigest = computeApprovalPresentedDigest(record);
  return record;
}

describe('run-manifest charter issuance', () => {
  let root = '';
  let caseRoot = '';
  const pathOptions = () => ({ rootDir: caseRoot });
  const memberOptions = () => ({ rootDir: caseRoot });
  const scope = {
    kind: 'run_manifest',
    tenant_slug: 'acme',
    manifest_hash: manifest.manifest_hash,
  } as const;
  const ensure = (requestId = 'req-1', now = NOW) =>
    ensureRunManifestCharter({
      approvalRequestId: requestId,
      manifest,
      now,
      pathOptions: pathOptions(),
      memberOptions: memberOptions(),
    });
  const member = (id: string, role: string, status = 'active') => {
    const dir = path.join(caseRoot, 'knowledge', 'personal', 'members');
    safeMkdir(dir, { recursive: true });
    safeWriteFile(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        member_id: id,
        display_name: id,
        status,
        memberships: [{ tenant_slug: 'acme', role }],
        access_registrations: [],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      })
    );
  };

  beforeAll(() => {
    root = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `rm-charter-${randomUUID()}`
    );
  });
  afterAll(() => {
    if (root) safeRmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    caseRoot = path.join(root, randomUUID());
    member('rmowner', 'owner');
    member('rmapprover', 'approver');
  });

  it('issues one charter from a verified human owner approval, idempotently', () => {
    vi.mocked(loadApprovalRequest).mockReturnValue(trustRecord());
    const first = ensure();
    expect(first.created).toBe(true);
    expect(assertProjectTrustApproval).toHaveBeenCalledWith('req-1', INPUT);
    const charter = first.charter;
    expect(charter.scope).toEqual(scope);
    expect(charter.accountable).toMatchObject({
      actor: 'user:rmowner',
      authority_basis: { kind: 'owner', evidence_ref: 'approval:project-trust/req-1' },
      statement_sha256: trustRecord().verifiedPresentedDigest,
      expires_at: new Date(Date.parse(DECIDED_AT) + 90 * 86_400_000).toISOString(),
      deputies: [],
    });
    expect(charter.envelope.manifest_operations).toEqual(runManifestGrantsFor(manifest));
    expect(charter.envelope.principal_modes).toEqual(['attended']);
    expect(charter.envelope.data_tier).toEqual({ read: ['confidential:acme'], write: [] });
    expect(charter.envelope.external_operations).toBeUndefined();
    expect(findActiveCharter(scope, NOW, pathOptions())?.charter_id).toBe(charter.charter_id);

    const again = ensure();
    expect(again).toEqual({ charter, created: false });
  });

  it('refuses to reuse a stored charter whose content was edited after issuance', () => {
    vi.mocked(loadApprovalRequest).mockReturnValue(trustRecord());
    const { charter } = ensure();
    const file = path.join(
      caseRoot,
      'knowledge',
      'confidential',
      'acme',
      'charters',
      'run-manifests',
      manifest.manifest_hash,
      `${charter.charter_id}.json`
    );
    // An attacker with file access widens the approved principal modes.
    safeWriteFile(
      file,
      JSON.stringify({
        ...charter,
        envelope: { ...charter.envelope, principal_modes: ['attended', 'unattended'] },
      })
    );
    expect(() => ensure()).toThrow('[RUN_MANIFEST_CHARTER_TAMPERED]');
    // A later issuance time alone is not a content change.
    safeWriteFile(file, JSON.stringify(charter));
    expect(ensure(undefined, new Date(NOW.getTime() + 60_000))).toEqual({
      charter,
      created: false,
    });
  });

  it('records each bound run once on the charter ledger', () => {
    vi.mocked(loadApprovalRequest).mockReturnValue(trustRecord());
    const { charter } = ensure();
    recordRunManifestRunStarted(
      charter,
      { run_id: 'run-a', principal_mode: 'attended' },
      pathOptions(),
      NOW
    );
    recordRunManifestRunStarted(
      charter,
      { run_id: 'run-a', principal_mode: 'attended' },
      pathOptions(),
      NOW
    );
    recordRunManifestRunStarted(
      charter,
      { run_id: 'run-b', principal_mode: 'attended' },
      pathOptions(),
      NOW
    );
    expect(
      readCharterLedger(charter, pathOptions())
        .filter((entry) => entry.kind === 'run_started')
        .map((entry) => (entry as { run_id: string }).run_id)
    ).toEqual(['run-a', 'run-b']);
  });

  it('carries the approved daily run cap; approvals from before the cap get the default', () => {
    vi.mocked(loadApprovalRequest).mockReturnValue(trustRecord({}, { runsPerDay: 5 }));
    const capped = ensure().charter;
    expect(capped.envelope.runs_per_day).toBe(5);
    expect(readRunManifestRunUsage(capped, pathOptions(), NOW)).toEqual({
      day: '2026-11-25',
      runs_today: 0,
      runs_per_day: 5,
    });

    caseRoot = path.join(root, randomUUID());
    member('rmowner', 'owner');
    vi.mocked(loadApprovalRequest).mockReturnValue(trustRecord());
    const legacy = ensure().charter;
    expect(legacy.envelope.runs_per_day).toBeUndefined();
    expect(readRunManifestRunUsage(legacy, pathOptions(), NOW).runs_per_day).toBe(
      DEFAULT_RUN_MANIFEST_RUNS_PER_DAY
    );
  });

  it('refuses a stored charter whose daily run cap was raised after issuance', () => {
    vi.mocked(loadApprovalRequest).mockReturnValue(trustRecord({}, { runsPerDay: 3 }));
    const { charter } = ensure();
    const file = path.join(
      caseRoot,
      'knowledge',
      'confidential',
      'acme',
      'charters',
      'run-manifests',
      manifest.manifest_hash,
      `${charter.charter_id}.json`
    );
    safeWriteFile(
      file,
      JSON.stringify({ ...charter, envelope: { ...charter.envelope, runs_per_day: 1000 } })
    );
    expect(() => ensure()).toThrow('[RUN_MANIFEST_CHARTER_TAMPERED]');
  });

  it('stops binding at the daily run cap, idempotently per run id, and resets at 00:00 UTC', () => {
    vi.mocked(loadApprovalRequest).mockReturnValue(trustRecord({}, { runsPerDay: 2 }));
    const { charter } = ensure();
    const start = (runId: string, at: Date) =>
      recordRunManifestRunStarted(
        charter,
        { run_id: runId, principal_mode: 'attended' },
        pathOptions(),
        at
      );
    expect(start('run-a', NOW)).toMatchObject({ recorded: true, runs_today: 1, runs_per_day: 2 });
    expect(start('run-b', NOW)).toMatchObject({ recorded: true, runs_today: 2 });
    // The same run id recorded again is admitted without counting twice.
    expect(start('run-a', NOW)).toMatchObject({
      recorded: true,
      already_recorded: true,
      runs_today: 2,
    });
    const lastMinute = new Date('2026-11-25T23:59:59.999Z');
    expect(start('run-c', lastMinute)).toEqual({
      recorded: false,
      reason: 'daily_cap',
      day: '2026-11-25',
      runs_today: 2,
      runs_per_day: 2,
    });
    const nextDay = new Date('2026-11-26T00:00:00.000Z');
    expect(start('run-c', nextDay)).toMatchObject({
      recorded: true,
      day: '2026-11-26',
      runs_today: 1,
    });
    // A run id recorded on an earlier UTC day counts again (no uncounted re-admission).
    expect(start('run-a', nextDay)).toMatchObject({
      recorded: true,
      already_recorded: false,
      runs_today: 2,
    });
    expect(start('run-b', nextDay)).toMatchObject({ recorded: false, reason: 'daily_cap' });
    expect(
      readCharterLedger(charter, pathOptions())
        .filter((entry) => entry.kind === 'run_started')
        .map((entry) => (entry as { run_id: string }).run_id)
    ).toEqual(['run-a', 'run-b', 'run-c', 'run-a']);
  });

  it('counts the day across re-approvals of the same manifest (re-approval does not reset it)', () => {
    vi.mocked(loadApprovalRequest).mockReturnValue(trustRecord({}, { runsPerDay: 2 }));
    const first = ensure().charter;
    const start = (target: typeof first, runId: string) =>
      recordRunManifestRunStarted(
        target,
        { run_id: runId, principal_mode: 'attended' },
        pathOptions(),
        NOW
      );
    start(first, 'run-a');
    start(first, 'run-b');
    vi.mocked(loadApprovalRequest).mockReturnValue(
      trustRecord({ id: 'req-2' }, { runsPerDay: 2, modes: ['attended', 'unattended'] })
    );
    expect(
      runManifestApprovalRunUsage({ approvalRequestId: 'req-2', manifest, now: NOW }, pathOptions())
    ).toEqual({ day: '2026-11-25', runs_today: 2, runs_per_day: 2 });
    const second = ensure('req-2').charter;
    expect(second.replaces_charter_id).toBe(first.charter_id);
    expect(start(second, 'run-c')).toMatchObject({
      recorded: false,
      reason: 'daily_cap',
      runs_today: 2,
    });
    // A run already counted today on the old charter is recorded on the new one
    // (the gate reads that ledger) without counting twice.
    expect(start(second, 'run-a')).toMatchObject({
      recorded: true,
      already_recorded: false,
      runs_today: 2,
    });
    expect(readRunManifestRunUsage(second, pathOptions(), NOW).runs_today).toBe(2);
  });

  it('reports usage for pipeline check without issuing the charter', () => {
    vi.mocked(loadApprovalRequest).mockReturnValue(trustRecord({}, { runsPerDay: 4 }));
    const usage = () =>
      runManifestApprovalRunUsage(
        { approvalRequestId: 'req-1', manifest, now: NOW },
        pathOptions()
      );
    expect(usage()).toEqual({ day: '2026-11-25', runs_today: 0, runs_per_day: 4 });
    expect(findActiveCharter(scope, NOW, pathOptions())).toBeNull();
    const { charter } = ensure();
    recordRunManifestRunStarted(
      charter,
      { run_id: 'run-a', principal_mode: 'attended' },
      pathOptions(),
      NOW
    );
    expect(usage()).toEqual({ day: '2026-11-25', runs_today: 1, runs_per_day: 4 });
  });

  it('never outlives the approval itself', () => {
    vi.mocked(loadApprovalRequest).mockReturnValue(
      trustRecord({ expiresAt: '2026-12-01T00:00:00.000Z' })
    );
    expect(ensure().charter.accountable.expires_at).toBe('2026-12-01T00:00:00.000Z');
  });

  it('replaces the charter of an older approval of the same manifest (e.g. unattended enabled)', () => {
    vi.mocked(loadApprovalRequest).mockReturnValue(trustRecord());
    const old = ensure().charter;
    vi.mocked(loadApprovalRequest).mockReturnValue(
      trustRecord({ id: 'req-2' }, { modes: ['attended', 'unattended'] })
    );
    const next = ensure('req-2').charter;
    expect(next.charter_id).not.toBe(old.charter_id);
    expect(next.replaces_charter_id).toBe(old.charter_id);
    expect(next.envelope.principal_modes).toEqual(['attended', 'unattended']);
    expect(findActiveCharter(scope, NOW, pathOptions())?.charter_id).toBe(next.charter_id);
    expect(readCharterLedger(old, pathOptions()).some((entry) => entry.kind === 'retired')).toBe(
      true
    );
  });

  it('does not issue when the current file no longer matches the trusted content', () => {
    vi.mocked(loadApprovalRequest).mockReturnValue(trustRecord());
    vi.mocked(assertProjectTrustApproval).mockImplementationOnce(() => {
      throw new Error('[TRUST_REQUIRED] project-local pipeline changed after approval');
    });
    expect(() => ensure()).toThrow('[TRUST_REQUIRED]');
    expect(findActiveCharter(scope, NOW, pathOptions())).toBeNull();
  });

  const refusals: Array<[string, () => ApprovalRequestRecord, RegExp]> = [
    [
      'an unauthenticated decision',
      () => trustRecord({ authenticated: false }),
      /lacks an authenticated human decision/,
    ],
    [
      'an agent decider',
      () => trustRecord({ decidedByType: 'ai_agent' }),
      /lacks an authenticated human decision/,
    ],
    [
      'a credential-only auth method',
      () => trustRecord({ decidedAuthMethod: 'local_token' }),
      /lacks an authenticated human decision/,
    ],
    [
      'a decision without a verified presented digest',
      () => trustRecord({ verifiedPresentedDigest: undefined }),
      /verified presentation/,
    ],
    [
      'a digest of a different card',
      () => trustRecord({ verifiedPresentedDigest: 'f'.repeat(64) }),
      /verified presentation/,
    ],
    [
      'an approval of another manifest',
      () => trustRecord({}, { manifestHash: 'd'.repeat(64) }),
      /approved another run manifest/,
    ],
    ['a v1 (file-only) trust record', () => trustRecord({}, { v1: true }), /\(v1\)/],
    [
      'a decider who is not a tenant owner',
      () => trustRecord({ decidedBy: 'user:rmapprover' }),
      /not an active owner of tenant acme/,
    ],
    [
      'an unknown decider',
      () => trustRecord({ decidedBy: 'user:nobody' }),
      /not an active owner of tenant acme/,
    ],
    ['a pending request', () => trustRecord({ status: 'pending' }), /is pending/],
    [
      'a revoked approval',
      () =>
        trustRecord({
          revocation: { revokedBy: 'user:rmowner', revokedAt: DECIDED_AT },
        } as Partial<ApprovalRequestRecord>),
      /was revoked/,
    ],
    [
      'an approval older than 90 days',
      () => trustRecord({ decidedAt: '2026-08-01T00:00:00.000Z' }),
      /older than 90 days/,
    ],
  ];
  it.each(refusals)('refuses %s and writes nothing', (_name, build, message) => {
    vi.mocked(loadApprovalRequest).mockReturnValue(build());
    expect(() => ensure()).toThrow(message);
    expect(findActiveCharter(scope, NOW, pathOptions())).toBeNull();
  });

  it('refuses a manifest whose body was altered after compilation', () => {
    vi.mocked(loadApprovalRequest).mockReturnValue(trustRecord());
    const altered = structuredClone(manifest);
    altered.requirements.effects[0].max_occurrences = 99;
    expect(() =>
      ensureRunManifestCharter({
        approvalRequestId: 'req-1',
        manifest: altered,
        now: NOW,
        pathOptions: pathOptions(),
        memberOptions: memberOptions(),
      })
    ).toThrow(/does not match its hash/);
  });

  it('refuses a manifest compiled from other content than the approved payload', () => {
    const other = compileRunManifest(STEPS, {
      inputPath: INPUT,
      contentSha256: 'e'.repeat(64),
      scope: { tier: 'confidential', tenantSlug: 'acme' },
    });
    vi.mocked(loadApprovalRequest).mockReturnValue(
      trustRecord({}, { manifestHash: other.manifest_hash })
    );
    expect(() =>
      ensureRunManifestCharter({
        approvalRequestId: 'req-1',
        manifest: other,
        now: NOW,
        pathOptions: pathOptions(),
        memberOptions: memberOptions(),
      })
    ).toThrow(/payload does not bind this file content/);
  });
});
