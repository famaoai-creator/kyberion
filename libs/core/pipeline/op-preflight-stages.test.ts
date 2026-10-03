import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeWriteFile } from '../secure-io.js';
import { auditChain } from '../governance/audit-chain.js';
import { _resetEgressPolicyCacheForTests } from '../egress-policy.js';
import {
  introductionResult,
  opPreflightStageCounts,
  egressPayloadHash,
  provenanceEgressResult,
  recordOpObservation,
  resetOpPreflightStagesForTests,
  setOpPreflightRolloutForTests,
  taintResult,
} from './op-preflight-stages.js';
import { setControlPlaneRuntimeRootForTests, readJournalTail } from '../cloudflare-os-journal.js';
import { resetSharedControlPlaneForTests, sharedControlPlane } from '../cloudflare-os-shared.js';
import {
  mintScopeEnvelope,
  resetScopeEnvelopeState,
  withScopeEnvelope,
} from '../scope-envelope.js';
import type { OpPreflightCall } from './op-preflight.js';

let testRoot: string;
let counter = 0;

beforeEach(() => {
  counter += 1;
  testRoot = pathResolver.shared(`tmp/op-stages-test-${process.pid}-${counter}`);
  safeMkdir(testRoot, { recursive: true });
  setControlPlaneRuntimeRootForTests(testRoot);
  resetSharedControlPlaneForTests();
  resetOpPreflightStagesForTests();
  resetScopeEnvelopeState();
  vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as never);
});

afterEach(() => {
  setControlPlaneRuntimeRootForTests(undefined);
  setOpPreflightRolloutForTests(undefined);
  vi.restoreAllMocks();
});

const call = (op: string, context?: Record<string, unknown>): OpPreflightCall => ({
  op,
  params: {},
  context,
  source: 'pipeline',
});

/** Run `fn` under a runtime-minted envelope — the only identity the stages trust. */
const inScope = <T>(fn: () => T): T =>
  withScopeEnvelope(
    mintScopeEnvelope({
      identity: {
        tenant_slug: 'tenant-a',
        mission_id: 'mission-s5',
        task_id: 'task-s5',
        tier: 'confidential',
      },
      policy: { purpose: 'stage test' },
    }),
    fn
  );

describe('introductionResult', () => {
  const writeInput = { _effect: 'write', _resource_ref: 'file:out/report.md' };

  it('warns without blocking when introduction is missing (warn mode)', () => {
    inScope(() =>
      expect(() => introductionResult(call('file:pipeline'), writeInput)).not.toThrow()
    );
  });

  it('blocks unintroduced writes in enforce mode', () => {
    setOpPreflightRolloutForTests({
      stages: { introduction: { default: 'enforce' } },
    });
    inScope(() =>
      expect(() => introductionResult(call('file:pipeline'), writeInput)).toThrow(
        '[POLICY_VIOLATION]'
      )
    );
  });

  it('skips service family ops (actuator-owned path)', () => {
    setOpPreflightRolloutForTests({
      stages: { introduction: { default: 'enforce', families: { service: 'off' } } },
    });
    inScope(() => expect(() => introductionResult(call('service:api'), writeInput)).not.toThrow());
  });

  it('passes when a matching introduction exists', async () => {
    setOpPreflightRolloutForTests({
      stages: { introduction: { default: 'enforce' } },
    });
    const held = sharedControlPlane().requestResourceIntroduction({
      missionId: 'mission-s5',
      taskId: 'task-s5',
      tenantSlug: 'tenant-a',
      service: 'file',
      resourceRef: 'file:out/report.md',
      scope: 'write',
      requestedBy: 'agent:x',
    });
    sharedControlPlane().decideHeldAction(held.id, 'approved', {
      resolvedBy: 'human:famao',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: held.payloadHash,
      effectBinding: held.effectBinding,
    });
    await sharedControlPlane().applyHeldAction(held.id);
    inScope(() =>
      expect(() => introductionResult(call('file:pipeline'), writeInput)).not.toThrow()
    );
  });

  it('ignores read effects and ops without resource refs', () => {
    inScope(() =>
      expect(() => introductionResult(call('file:pipeline'), { _effect: 'read' })).not.toThrow()
    );
    inScope(() =>
      expect(() => introductionResult(call('file:pipeline'), { _effect: 'write' })).not.toThrow()
    );
  });
});

describe('taintResult', () => {
  it('stamps the mission taint projection for egress ops', () => {
    sharedControlPlane().recordObservation({
      missionId: 'mission-s5',
      service: 'github',
      resourceRef: 'repo:x',
      tier: 'confidential',
      tenantSlug: 'tenant-a',
      purpose: 'p',
      summary: 's',
    });
    const result = inScope(() => taintResult(call('service:api'), { _effect: 'egress' }));
    expect(result?.repaired_input?._egress_taint).toMatchObject({
      highestTier: 'confidential',
    });
  });

  it('ignores non-egress ops', () => {
    expect(taintResult(call('file:pipeline'), { _effect: 'read' })).toBeUndefined();
  });
});

describe('provenanceEgressResult (SC-06)', () => {
  const PUBLIC_HOST = 'https://public.example/upload';
  const TENANT_HOST = 'https://review.tenant-a.example/upload';
  const OTHER_TENANT_HOST = 'https://review.tenant-b.example/upload';
  const UNLISTED_HOST = 'https://unlisted.example/upload';

  const observe = (tier: 'public' | 'confidential' | 'personal', tenantSlug = 'tenant-a') =>
    sharedControlPlane().recordObservation({
      missionId: 'mission-s5',
      service: 'github',
      resourceRef: 'repo:x',
      tier,
      tenantSlug,
      purpose: 'p',
      summary: 's',
    });

  const egressInput = (overrides: Record<string, unknown> = {}) => ({
    _effect: 'egress',
    _egress_destination: PUBLIC_HOST,
    ...overrides,
  });
  const guard = (input: Record<string, unknown>) =>
    inScope(() => provenanceEgressResult(call('export:publish'), input));

  beforeEach(() => {
    const dir = pathResolver.sharedTmp(`egress-dest-${process.pid}`);
    safeMkdir(dir, { recursive: true });
    const policyPath = path.join(dir, 'egress-policy.json');
    safeWriteFile(
      policyPath,
      JSON.stringify({
        version: '1',
        mode: 'enforce',
        manual_allowed_domains: ['public.example'],
        blocked_domains: ['evil.example'],
        tenant_allowed_domains: {
          'tenant-a': ['review.tenant-a.example'],
          'tenant-b': ['review.tenant-b.example'],
        },
      })
    );
    process.env.KYBERION_EGRESS_POLICY_PATH = policyPath;
    _resetEgressPolicyCacheForTests();
    setOpPreflightRolloutForTests({ stages: { egress: { default: 'enforce' } } });
  });

  afterEach(() => {
    delete process.env.KYBERION_EGRESS_POLICY_PATH;
    _resetEgressPolicyCacheForTests();
  });

  it('denies a public destination after a confidential observation', () => {
    observe('confidential');
    expect(guard(egressInput())?.decision).toBe('block');
  });

  it('allows a destination the policy approves for the mission tenant', () => {
    observe('confidential');
    expect(guard(egressInput({ _egress_destination: TENANT_HOST }))).toBeUndefined();
  });

  it('denies a host that is only approved for a different tenant', () => {
    observe('confidential');
    expect(guard(egressInput({ _egress_destination: OTHER_TENANT_HOST }))?.decision).toBe('block');
  });

  it('denies unlisted and blocked destinations (external audience)', () => {
    observe('public');
    expect(guard(egressInput({ _egress_destination: UNLISTED_HOST }))?.decision).toBe('block');
    expect(guard(egressInput({ _egress_destination: 'https://evil.example/x' }))?.decision).toBe(
      'block'
    );
  });

  it('ignores an audience, tenant or hash the caller claims about the payload', () => {
    observe('confidential');
    const forged = egressInput({
      _egress_destination: UNLISTED_HOST,
      target_audience: 'personal',
      audience: 'personal',
      target_tenant: 'tenant-a',
      tenant_slug: 'tenant-a',
    });
    expect(guard(forged)?.decision).toBe('block');
  });

  it('passes an untainted mission', () => {
    expect(guard(egressInput({ _egress_destination: UNLISTED_HOST }))).toBeUndefined();
  });

  it('fails closed when a tainted mission has no declared destination', () => {
    observe('confidential');
    const { _egress_destination: _omitted, ...undeclared } = egressInput();
    expect(guard({ ...undeclared, body: 'quarterly numbers' })?.decision).toBe('block');
  });

  it('lets a declassified artifact through — and only that content', async () => {
    observe('confidential');
    const bound = egressInput({ body: 'report v1' });
    const held = sharedControlPlane().requestDeclassify({
      missionId: 'mission-s5',
      tenantSlug: 'tenant-a',
      artifactRef: 'report:v1',
      payloadHash: egressPayloadHash(bound),
      targetAudience: 'public',
      targetTenant: 'tenant-a',
      requestedBy: 'agent:x',
    });
    sharedControlPlane().decideHeldAction(held.id, 'approved', {
      resolvedBy: 'human:famao',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: held.payloadHash,
      effectBinding: held.effectBinding,
    });
    await sharedControlPlane().applyHeldAction(held.id);

    expect(guard(bound)).toBeUndefined();
    // Changed content is denied again, even when it claims the approved hash.
    expect(
      guard({ ...bound, body: 'confidential appendix', payload_hash: egressPayloadHash(bound) })
        ?.decision
    ).toBe('block');
  });

  it('never trusts an input-carried _egress_taint', () => {
    observe('confidential');
    const fakeTaint = {
      missionId: 'mission-s5',
      highestTier: 'public',
      tenants: [],
      prohibitExternal: false,
      observationIds: [],
    };
    expect(guard(egressInput({ _egress_taint: fakeTaint }))?.decision).toBe('block');
  });

  it('warns without blocking in warn rollout mode', () => {
    setOpPreflightRolloutForTests({ stages: { egress: { default: 'warn' } } });
    observe('confidential');
    expect(guard(egressInput())).toBeUndefined();
    expect(opPreflightStageCounts()['egress:denied']).toBe(1);
  });
});

describe('recordOpObservation', () => {
  it('aggregates a read op into the observation journal', () => {
    inScope(() =>
      recordOpObservation('file:pipeline', {
        _effect: 'read',
        _resource_ref: 'file:in/data.json',
      })
    );
    const nsDir = path.join(testRoot, 'confidential', 'tenant-a', 'cloudflare-os');
    const { events } = readJournalTail(nsDir, 0);
    expect(events.some((e) => e.kind === 'observation')).toBe(true);
    const aggregate = sharedControlPlane()
      .listObservationAggregates('mission-s5')
      .find((a) => a.resourceRef === 'file:in/data.json');
    expect(aggregate?.count).toBe(1);
  });

  it('skips non-read ops and service family (actuator-owned path)', () => {
    inScope(() => recordOpObservation('service:api', { _effect: 'read', _resource_ref: 'x' }));
    inScope(() => recordOpObservation('file:pipeline', { _effect: 'write' }));
    expect(sharedControlPlane().listObservationAggregates('mission-s5')).toHaveLength(0);
  });
});
