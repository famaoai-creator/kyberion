import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir } from '../secure-io.js';
import { auditChain } from '../governance/audit-chain.js';
import {
  introductionResult,
  recordOpObservation,
  resetOpPreflightStagesForTests,
  setOpPreflightRolloutForTests,
  taintResult,
} from './op-preflight-stages.js';
import { setControlPlaneRuntimeRootForTests, readJournalTail } from '../cloudflare-os-journal.js';
import { resetSharedControlPlaneForTests, sharedControlPlane } from '../cloudflare-os-shared.js';
import { resetScopeEnvelopeState } from '../scope-envelope.js';
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

const scoped = {
  mission_id: 'mission-s5',
  task_id: 'task-s5',
  tenant_slug: 'tenant-a',
  read_tiers: ['confidential'],
  purpose: 'stage test',
};

describe('introductionResult', () => {
  const writeInput = {
    _effect: 'write',
    _resource_ref: 'file:out/report.md',
    security_scope: scoped,
  };

  it('warns without blocking when introduction is missing (warn mode)', () => {
    expect(() => introductionResult(call('file:pipeline'), writeInput)).not.toThrow();
  });

  it('blocks unintroduced writes in enforce mode', () => {
    setOpPreflightRolloutForTests({
      stages: { introduction: { default: 'enforce' } },
    });
    expect(() => introductionResult(call('file:pipeline'), writeInput)).toThrow(
      '[POLICY_VIOLATION]'
    );
  });

  it('skips service family ops (actuator-owned path)', () => {
    setOpPreflightRolloutForTests({
      stages: { introduction: { default: 'enforce', families: { service: 'off' } } },
    });
    expect(() => introductionResult(call('service:api'), writeInput)).not.toThrow();
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
    expect(() => introductionResult(call('file:pipeline'), writeInput)).not.toThrow();
  });

  it('ignores read effects and ops without resource refs', () => {
    expect(() =>
      introductionResult(call('file:pipeline'), { _effect: 'read', security_scope: scoped })
    ).not.toThrow();
    expect(() =>
      introductionResult(call('file:pipeline'), { _effect: 'write', security_scope: scoped })
    ).not.toThrow();
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
    const result = taintResult(call('service:api'), {
      _effect: 'egress',
      security_scope: scoped,
    });
    expect(result?.repaired_input?._egress_taint).toMatchObject({
      highestTier: 'confidential',
    });
  });

  it('ignores non-egress ops', () => {
    expect(taintResult(call('file:pipeline'), { _effect: 'read' })).toBeUndefined();
  });
});

describe('recordOpObservation', () => {
  it('aggregates a read op into the observation journal', () => {
    recordOpObservation('file:pipeline', {
      _effect: 'read',
      _resource_ref: 'file:in/data.json',
      security_scope: scoped,
    });
    const nsDir = path.join(testRoot, 'confidential', 'tenant-a', 'cloudflare-os');
    const { events } = readJournalTail(nsDir, 0);
    expect(events.some((e) => e.kind === 'observation')).toBe(true);
    const aggregate = sharedControlPlane()
      .listObservationAggregates('mission-s5')
      .find((a) => a.resourceRef === 'file:in/data.json');
    expect(aggregate?.count).toBe(1);
  });

  it('skips non-read ops and service family (actuator-owned path)', () => {
    recordOpObservation('service:api', {
      _effect: 'read',
      _resource_ref: 'x',
      security_scope: scoped,
    });
    recordOpObservation('file:pipeline', { _effect: 'write', security_scope: scoped });
    expect(sharedControlPlane().listObservationAggregates('mission-s5')).toHaveLength(0);
  });
});
