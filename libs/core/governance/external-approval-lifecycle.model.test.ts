import { expect, it, vi } from 'vitest';
import {
  declaredAuthorizationEntries,
  operationAuthorization,
  requiresApprovalAdmission,
} from '../foundation/authorization-registry.js';
import { checkFiniteStateSafety } from '../testing/finite-state-checker.js';
import { isCharterEligiblePolicy } from './approval-gate-charter.js';
import { runExternalOperation } from './external-operation.js';
import {
  externalOperationGrantMatches,
  isDelegableExternalOperation,
  resolveCharterExternalOperationTarget,
} from './external-operation-target.js';

it('checks the common approval and execution lifecycle under every registered external operation class', () => {
  type State = {
    operation: string;
    mandatory: boolean;
    delegation: 'missing' | 'current' | 'revoked';
    human: 'missing' | 'pending' | 'approved' | 'revoked';
    binding: 'current' | 'changed';
    claim: 'none' | 'charter' | 'human';
    outcome: 'none' | 'succeeded' | 'unknown';
  };
  const operations = declaredAuthorizationEntries()
    .filter(
      ({ axis, match, entry }) =>
        axis === 'operation' &&
        match === 'exact' &&
        entry.authority.kind === 'admission' &&
        entry.authority.boundary === 'external'
    )
    .map(({ subject }) => subject)
    .filter((operation) => requiresApprovalAdmission(operationAuthorization(operation)));
  expect(operations).toContain('voice:speak');
  const initial: State[] = [...new Set(operations)].flatMap((operation) =>
    [false, true].map((mandatory) => ({
      operation,
      mandatory,
      delegation: 'missing',
      human: 'missing',
      binding: 'current',
      claim: 'none',
      outcome: 'none',
    }))
  );
  const charterProgress = new Set<string>();
  const humanProgress = new Set<string>();
  const report = checkFiniteStateSafety<State>(
    {
      initial,
      key: JSON.stringify,
      next(state) {
        if (state.outcome === 'succeeded') {
          (state.claim === 'charter' ? charterProgress : humanProgress).add(state.operation);
        }
        if (state.outcome !== 'none') return [];
        const next = [];
        const add = (action: string, patch: Partial<State>) =>
          next.push({ action, state: { ...state, ...patch } });
        const eligible =
          isDelegableExternalOperation(state.operation) &&
          isCharterEligiblePolicy({
            requiresApproval: true,
            mandatoryApproval: state.mandatory,
            missingRequirements: [],
          });
        if (state.delegation === 'missing' && eligible)
          add('bind a current grant', { delegation: 'current' });
        if (state.delegation === 'current')
          add('revoke or expire grant', { delegation: 'revoked' });
        if (state.human === 'missing') add('open human request', { human: 'pending' });
        if (state.human === 'pending')
          add('authenticate and decide exact request', { human: 'approved' });
        if (state.human === 'approved') add('revoke human decision', { human: 'revoked' });
        if (state.binding === 'current') add('change the reviewed binding', { binding: 'changed' });
        if (state.claim === 'none' && state.binding === 'current') {
          if (state.delegation === 'current' && eligible)
            add('reserve exact charter effect', { claim: 'charter' });
          if (state.human === 'approved') add('reserve exact approved effect', { claim: 'human' });
        } else if (state.claim !== 'none') {
          const proof =
            state.claim === 'charter'
              ? state.delegation === 'current' && eligible
              : state.human === 'approved';
          if (proof && state.binding === 'current')
            add('commit reserved effect', { outcome: 'succeeded' });
          add('interruption with unresolved result', { outcome: 'unknown' });
        }
        return next;
      },
      invariants: {
        registeredBoundaryRequiresAdmission: (s) =>
          requiresApprovalAdmission(operationAuthorization(s.operation)),
        mandatoryApprovalNeverUsesGrant: (s) => !s.mandatory || s.claim !== 'charter',
        unregisteredDelegationNeverClaims: (s) =>
          s.claim !== 'charter' || isDelegableExternalOperation(s.operation),
        effectRequiresClaim: (s) => s.outcome === 'none' || s.claim !== 'none',
        successRequiresCurrentBinding: (s) => s.outcome !== 'succeeded' || s.binding === 'current',
      },
    },
    200_000
  );
  expect(report.status).toBe('verified');
  expect(humanProgress).toEqual(new Set(operations));
  expect(charterProgress).toEqual(new Set(operations.filter(isDelegableExternalOperation)));
});

it.each(['voice:speak', 'voice:playback'] as const)(
  'matches portable %s grants after restore and retains exact legacy platform limits',
  (operation_id) => {
    const grant = JSON.parse(JSON.stringify({ operation_id }));
    const bound = { operation_id, platform: 'darwin' } as const;
    for (const platform of ['darwin', 'linux', 'win32']) {
      const target = resolveCharterExternalOperationTarget(operation_id, { params: { platform } });
      expect(target).toBeDefined();
      expect(externalOperationGrantMatches(grant, target!)).toBe(true);
      expect(externalOperationGrantMatches(bound, target!)).toBe(platform === 'darwin');
    }
  }
);

it('requires a declared playback platform and blocks an unbound caller without invoking audio', async () => {
  const effect = { text: 'test fixture', options: { timeoutMs: 30_000 } };
  expect(isDelegableExternalOperation('voice:speak')).toBe(true);
  expect(resolveCharterExternalOperationTarget('voice:speak', effect)).toBeUndefined();
  const target = resolveCharterExternalOperationTarget('voice:speak', {
    params: { platform: 'darwin', text: 'test fixture' },
  });
  expect(target).toEqual({ operation_id: 'voice:speak', platform: 'darwin' });
  expect(
    externalOperationGrantMatches({ operation_id: 'voice:speak', platform: 'darwin' }, target!)
  ).toBe(true);
  const play = vi.fn(async () => 'would play');
  const result = runExternalOperation(
    {
      operationId: 'voice:speak',
      requiresApproval: true,
      delegable: true,
      effect,
    },
    play
  );
  await expect(result).rejects.toMatchObject({
    approval: { allowed: false, requestStatus: 'human_required' },
  });
  await expect(result).rejects.not.toHaveProperty('approval.requestId');
  expect(play).not.toHaveBeenCalled();
});
