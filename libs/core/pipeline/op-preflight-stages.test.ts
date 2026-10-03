import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir } from '../secure-io.js';
import { auditChain } from '../governance/audit-chain.js';
import {
  introductionResult,
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
    ...overrides,
  });

  beforeEach(() => {
    setOpPreflightRolloutForTests({ stages: { egress: { default: 'enforce' } } });
  });

  it('denies a public-audience egress after a confidential observation', () => {
    observe('confidential');
    const result = inScope(() =>
      provenanceEgressResult(
        call('export:publish'),
        egressInput({ target_audience: 'public', target_tenant: 'tenant-a' })
      )
    );
    expect(result?.decision).toBe('block');
  });

  it('denies egress to an unobserved tenant', () => {
    observe('confidential');
    const result = inScope(() =>
      provenanceEgressResult(
        call('export:publish'),
        egressInput({ target_audience: 'confidential', target_tenant: 'tenant-b' })
      )
    );
    expect(result?.decision).toBe('block');
  });

  it('denies the external audience outright', () => {
    observe('public');
    const result = inScope(() =>
      provenanceEgressResult(
        call('export:publish'),
        egressInput({ target_audience: 'external', target_tenant: 'tenant-a' })
      )
    );
    expect(result?.decision).toBe('block');
  });

  it('passes an untainted mission', () => {
    expect(
      inScope(() =>
        provenanceEgressResult(
          call('export:publish'),
          egressInput({ target_audience: 'confidential', target_tenant: 'tenant-a' })
        )
      )
    ).toBeUndefined();
  });

  it('lets a declassified payloadHash through — and only that hash', async () => {
    observe('confidential');
    const held = sharedControlPlane().requestDeclassify({
      missionId: 'mission-s5',
      tenantSlug: 'tenant-a',
      artifactRef: 'report:v1',
      payloadHash: 'hash-report-v1',
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
    expect(
      sharedControlPlane().isDeclassified('mission-s5', 'hash-report-v1', 'public', 'tenant-a')
    ).toBe(true);

    // The bound artifact passes…
    expect(
      inScope(() =>
        provenanceEgressResult(
          call('export:publish'),
          egressInput({
            target_audience: 'public',
            target_tenant: 'tenant-a',
            payload_hash: 'hash-report-v1',
          })
        )
      )
    ).toBeUndefined();
    // …but a changed payload (different hash) is denied again.
    expect(
      inScope(() =>
        provenanceEgressResult(
          call('export:publish'),
          egressInput({
            target_audience: 'public',
            target_tenant: 'tenant-a',
            payload_hash: 'hash-report-v2',
          })
        )
      )?.decision
    ).toBe('block');
  });

  it('never trusts an input-carried _egress_taint', () => {
    observe('confidential');
    const result = inScope(() =>
      provenanceEgressResult(
        call('export:publish'),
        egressInput({
          target_audience: 'public',
          target_tenant: 'tenant-a',
          // A client-injected clean projection must not launder the mission's
          // real confidential taint.
          _egress_taint: {
            missionId: 'mission-s5',
            highestTier: 'public',
            tenants: ['tenant-a'],
            prohibitExternal: false,
            observationIds: [],
          },
        })
      )
    );
    expect(result?.decision).toBe('block');
  });

  it('warns without blocking in warn rollout mode', () => {
    setOpPreflightRolloutForTests({ stages: { egress: { default: 'warn' } } });
    observe('personal');
    expect(
      inScope(() =>
        provenanceEgressResult(
          call('export:publish'),
          egressInput({ target_audience: 'public', target_tenant: 'tenant-a' })
        )
      )
    ).toBeUndefined();
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
