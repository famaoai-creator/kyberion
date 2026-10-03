import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir } from '../secure-io.js';
import { auditChain } from '../governance/audit-chain.js';
import {
  introductionResult,
  opPreflightStageCounts,
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
    expect(opPreflightStageCounts()['introduction:warn']).toBe(1);
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
    expect(opPreflightStageCounts()['introduction:denied']).toBe(1);
  });

  it('skips service family ops (actuator-owned path)', () => {
    setOpPreflightRolloutForTests({
      stages: { introduction: { default: 'enforce', families: { service: 'off' } } },
    });
    inScope(() => expect(() => introductionResult(call('service:api'), writeInput)).not.toThrow());
  });

  it('passes when a matching introduction exists, counted as allowed', async () => {
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
    expect(opPreflightStageCounts()['introduction:allowed']).toBe(1);
    expect(opPreflightStageCounts()['introduction:warn']).toBeUndefined();
  });

  it('ignores read effects and ops without resource refs', () => {
    inScope(() => {
      expect(() => introductionResult(call('file:pipeline'), { _effect: 'read' })).not.toThrow();
      expect(() => introductionResult(call('file:pipeline'), { _effect: 'write' })).not.toThrow();
    });
  });

  it('never takes identity from the call input', () => {
    setOpPreflightRolloutForTests({
      stages: { introduction: { default: 'enforce' } },
    });
    // No envelope and no process mission: caller-declared scope is ignored,
    // so the stage skips (and counts) instead of evaluating forged identity.
    expect(() =>
      introductionResult(call('file:pipeline'), {
        ...writeInput,
        mission_id: 'mission-s5',
        security_scope: {
          mission_id: 'mission-s5',
          tenant_slug: 'tenant-a',
          read_tiers: ['public'],
        },
      })
    ).not.toThrow();
    expect(opPreflightStageCounts()['introduction:skipped']).toBe(1);
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

  it('does not project another mission taint named by the call input', () => {
    sharedControlPlane().recordObservation({
      missionId: 'mission-victim',
      service: 'github',
      resourceRef: 'repo:x',
      tier: 'personal',
      tenantSlug: 'tenant-a',
      purpose: 'p',
      summary: 's',
    });
    const result = inScope(() =>
      taintResult(call('service:api'), { _effect: 'egress', mission_id: 'mission-victim' })
    );
    expect(result?.repaired_input?._egress_taint).not.toMatchObject({ highestTier: 'personal' });
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
    expect(aggregate?.tier).toBe('confidential');
    expect(opPreflightStageCounts()['observation:allowed']).toBe(1);
  });

  it('skips non-read ops and service family (actuator-owned path)', () => {
    inScope(() => {
      recordOpObservation('service:api', { _effect: 'read', _resource_ref: 'x' });
      recordOpObservation('file:pipeline', { _effect: 'write' });
    });
    expect(sharedControlPlane().listObservationAggregates('mission-s5')).toHaveLength(0);
  });

  it('ignores a mission/scope/tier declared by the call input', () => {
    recordOpObservation('file:pipeline', {
      _effect: 'read',
      _resource_ref: 'knowledge/confidential/tenant-a/secret.md',
      mission_id: 'mission-victim',
      security_scope: {
        mission_id: 'mission-victim',
        tenant_slug: 'tenant-a',
        read_tiers: ['public'],
        purpose: 'x',
      },
    });
    expect(sharedControlPlane().listObservationAggregates()).toHaveLength(0);
  });
});
