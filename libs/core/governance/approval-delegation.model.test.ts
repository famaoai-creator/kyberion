import { expect, it } from 'vitest';
import { checkFiniteStateSafety } from '../testing/finite-state-checker.js';
import { validateHumanFinalDecision } from './approval-human-decision.js';
import { evaluateSeparationOfDuties } from './approval-separation-of-duties.js';

it('checks that execution delegation cannot provide human decision authority', () => {
  type Principal = 'agent' | 'owner' | 'other-human';
  type State = {
    delegation: 'active' | 'expired' | 'absent';
    separation: boolean;
    input?: {
      principal: Principal;
      authenticated: boolean;
      serverResolved: boolean;
      bindingMatches: boolean;
    };
    accepted?: boolean;
  };
  const accountability = {
    finalDecision: 'human_only',
    payloadHash: 'reviewed-payload',
    effectBinding: 'reviewed-operation',
  } as const;
  const result = checkFiniteStateSafety<State>({
    initial: (['active', 'expired', 'absent'] as const).flatMap((delegation) =>
      [false, true].map((separation) => ({ delegation, separation }))
    ),
    key: JSON.stringify,
    next(state) {
      if (state.input) return [];
      const steps = [];
      for (const principal of ['agent', 'owner', 'other-human'] as const)
        for (const authenticated of [false, true])
          for (const serverResolved of [false, true])
            for (const bindingMatches of [false, true]) {
              let accepted: boolean;
              try {
                validateHumanFinalDecision({
                  accountability,
                  decidedByType: principal === 'agent' ? 'ai_agent' : 'human',
                  authenticated,
                  authMethod: 'terminal_attested',
                  payloadHash: bindingMatches ? accountability.payloadHash : 'changed',
                  effectBinding: accountability.effectBinding,
                  mode: 'enforce',
                });
                accepted =
                  !state.separation ||
                  !evaluateSeparationOfDuties(
                    { requestedBy: 'user:owner', requestedByContext: undefined, source: undefined },
                    'user:' + principal,
                    serverResolved ? 'server_resolved' : 'caller_supplied'
                  );
              } catch {
                accepted = false;
              }
              steps.push({
                action: 'try decision',
                state: {
                  ...state,
                  input: { principal, authenticated, serverResolved, bindingMatches },
                  accepted,
                },
              });
            }
      return steps;
    },
    invariants: {
      grantNeverReplacesHumanProof: ({ input, accepted }) =>
        !accepted ||
        Boolean(
          input && input.principal !== 'agent' && input.authenticated && input.bindingMatches
        ),
      separationRequiresIndependentDecider: ({ separation, input, accepted }) =>
        !accepted ||
        !separation ||
        Boolean(input && input.principal === 'other-human' && input.serverResolved),
      independentHumanCanApproveWithAnyGrantState: ({ input, accepted }) =>
        !(
          input?.principal === 'other-human' &&
          input.authenticated &&
          input.serverResolved &&
          input.bindingMatches
        ) || accepted === true,
    },
  });
  expect(result).toMatchObject({ status: 'verified', visited: 150, transitions: 144 });
});

it('finds the terminal-only progress blocker when the requester and installed decider are the same', () => {
  type State = { secondHuman: boolean; approved: boolean; attempted: boolean };
  const inspect = (secondHuman: boolean) =>
    checkFiniteStateSafety<State>({
      initial: [{ secondHuman, approved: false, attempted: false }],
      key: JSON.stringify,
      next(state) {
        if (state.attempted) return [];
        const requester = {
          requestedBy: 'user:owner',
          requestedByContext: undefined,
          source: undefined,
        };
        // Standalone CLI resolves the installed owner. A distinct enrolled human
        // can instead decide through a surface that resolves their own principal.
        const candidates = state.secondHuman ? ['user:owner', 'user:reviewer'] : ['user:owner'];
        const approved = candidates.some(
          (identity) => !evaluateSeparationOfDuties(requester, identity, 'server_resolved')
        );
        return [
          {
            action: 'attempt every available human decision route',
            state: {
              ...state,
              approved,
              attempted: true,
            },
          },
        ];
      },
      invariants: { approvalReachable: (state) => !state.attempted || state.approved },
    });
  expect(inspect(false)).toMatchObject({ status: 'violated', invariant: 'approvalReachable' });
  expect(inspect(true)).toMatchObject({ status: 'verified' });
});

it('checks one durable effect owner across human and delegated claims', () => {
  type State = {
    grant: 'active' | 'revoked';
    approval: 'pending' | 'approved' | 'revoked';
    binding: 'unchanged' | 'changed';
    permit: boolean;
    owner: 'none' | 'human' | 'delegated';
    effect: 'none' | 'committed' | 'unknown';
  };
  const report = checkFiniteStateSafety<State>({
    initial: [
      {
        grant: 'active',
        approval: 'pending',
        binding: 'unchanged',
        permit: false,
        owner: 'none',
        effect: 'none',
      },
    ],
    key: JSON.stringify,
    next(state) {
      const steps = [];
      const step = (action: string, patch: Partial<State>) => ({
        action,
        state: { ...state, ...patch },
      });
      if (state.grant === 'active') steps.push(step('revoke the grant', { grant: 'revoked' }));
      if (state.approval === 'pending')
        steps.push(step('authenticated human approves', { approval: 'approved' }));
      if (state.approval === 'approved')
        steps.push(step('revoke the decision', { approval: 'revoked' }));
      if (state.binding === 'unchanged')
        steps.push(step('change effect binding', { binding: 'changed' }));
      if (state.owner === 'none' && state.binding === 'unchanged') {
        if (state.grant === 'active' && !state.permit)
          steps.push(step('issue delegated permit', { permit: true }));
        if (state.grant === 'active' && state.permit)
          steps.push(step('delegated claimant wins', { owner: 'delegated' }));
        if (state.approval === 'approved')
          steps.push(step('human claimant wins', { owner: 'human' }));
      }
      if (state.owner !== 'none' && state.effect === 'none') {
        steps.push(step('effect result remains uncertain', { effect: 'unknown' }));
        const authorized =
          state.binding === 'unchanged' &&
          (state.owner === 'human' ? state.approval === 'approved' : state.grant === 'active');
        if (authorized) steps.push(step('commit exact claimed effect', { effect: 'committed' }));
      }
      return steps;
    },
    invariants: {
      effectHasDurableClaim: (state) => state.effect === 'none' || state.owner !== 'none',
      delegatedClaimHasPermit: (state) => state.owner !== 'delegated' || state.permit,
    },
  });
  expect(report.status).toBe('verified');
});
