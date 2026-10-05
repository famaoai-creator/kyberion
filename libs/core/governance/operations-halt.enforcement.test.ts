import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';
import {
  WorkCoordinationError,
  assertWorkClaimsAllowed,
} from '../workforce/work-coordination-error.js';
import { resolveSurfaceApprovalReply } from '../surface/surface-approval-ui.js';
import { t } from '../t.js';
import { routeAutonomousDecision } from './approval-decision-routing.js';
import { tickVetoWindows } from './approval-veto-window.js';
import type { AutonomousOpsGateResult } from './autonomous-ops-gate.js';
import {
  engageOperationsHalt,
  getOperationsHaltState,
  isOperationsHalted,
  releaseOperationsHalt,
} from './operations-halt.js';

// Under vitest the halt flag is per-process (operations-halt.ts), so engaging
// it here never touches the live system or other test workers.
afterEach(() => {
  releaseOperationsHalt({ by: 'test' });
  safeRmSync(pathResolver.shared('runtime/vitest-operations-halt'), {
    recursive: true,
    force: true,
  });
});

function gate(): AutonomousOpsGateResult {
  return {
    actionId: 'pr_merge_medium',
    decision: 'auto',
    allowed: true,
    score: 1,
    maxScore: 6,
    policyVersion: '1.1.0',
    executionMode: 'apply',
    reason: 'autonomous ops score 1/6',
    axes: { scope: 0, reversibility: 0, sensitivity: 0, confidence: 1 },
    shadow: false,
    escalations: [],
    highRiskPathMatches: [],
  };
}

describe('operations halt enforcement', () => {
  it('uses an isolated flag under vitest', () => {
    expect(isOperationsHalted()).toBe(false);
    engageOperationsHalt({ by: 'test' });
    expect(isOperationsHalted()).toBe(true);
  });

  it('refuses new work claims while halted and allows them again after release', () => {
    expect(() => assertWorkClaimsAllowed('item-1')).not.toThrow();
    engageOperationsHalt({ by: 'test' });
    expect(() => assertWorkClaimsAllowed('item-1')).toThrow(WorkCoordinationError);
    releaseOperationsHalt({ by: 'test' });
    expect(() => assertWorkClaimsAllowed('item-1')).not.toThrow();
  });

  it('parks an action the gate would let proceed, without a card', () => {
    const input = {
      role: 'mission_controller' as const,
      gate: gate(),
      title: 'Merge PR 7',
      question: 'Merge PR 7?',
      recommendation: 'Approve',
      requestedBy: 'agent:test',
    };
    expect(routeAutonomousDecision(input)).toMatchObject({ proceed: true, parked: false });
    engageOperationsHalt({ by: 'test' });
    const parked = routeAutonomousDecision(input);
    expect(parked).toMatchObject({ proceed: false, parked: true, notified: false });
    expect(parked.requestId).toBeUndefined();
  });

  it('stops veto windows from advancing while halted', () => {
    engageOperationsHalt({ by: 'test' });
    expect(tickVetoWindows('mission_controller')).toEqual({
      proceeded: [],
      shadowElapsed: [],
      fellBack: [],
      errors: [],
    });
  });
});

describe('chat halt commands', () => {
  const reply = (text: string) =>
    resolveSurfaceApprovalReply({
      surface: 'telegram',
      channel: 'chat-1',
      threadTs: 'thread-1',
      text,
      decidedBy: '42',
      locale: 'en',
    });

  it('engages the halt from an explicit token and says so once', () => {
    const first = reply('/halt');
    expect(first).toMatchObject({
      handled: true,
      reply: t('bridge:ops_halt_engaged', undefined, 'en'),
    });
    expect(getOperationsHaltState()).toMatchObject({ halted: true, by: 'telegram:42' });
    expect(reply('全停止')).toMatchObject({
      reply: t('bridge:ops_halt_already', undefined, 'en'),
    });
  });

  it('never releases from chat, only points at the CLI', () => {
    engageOperationsHalt({ by: 'test' });
    expect(reply('/resume')).toMatchObject({
      handled: true,
      reply: t('bridge:ops_halt_resume_cli', undefined, 'en'),
    });
    expect(isOperationsHalted()).toBe(true);
  });

  it('ignores ordinary words so conversation cannot halt the system', () => {
    expect(reply('stop')).toEqual({ handled: false });
    expect(reply('please halt the build')).toEqual({ handled: false });
    expect(isOperationsHalted()).toBe(false);
  });
});
