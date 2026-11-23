import { expect, it } from 'vitest';
import { checkFiniteStateSafety, type ModelStep } from '../testing/finite-state-checker.js';

type State = {
  member: boolean;
  nhi: 'absent' | 'provisioned' | 'active';
  authority: 'absent' | 'reviewed' | 'approved';
  tenant: 'unbound' | 'bound' | 'probed' | 'accepted';
  tenantActive: boolean;
  customer: 'unregistered' | 'registered' | 'evidenced';
  customerDecided: boolean;
};

const initial: State = {
  member: false,
  nhi: 'absent',
  authority: 'absent',
  tenant: 'unbound',
  tenantActive: false,
  customer: 'unregistered',
  customerDecided: false,
};

type Bypass = 'owner' | 'activation' | 'tenant' | 'customer';

function checkOnboarding(bypass?: Bypass) {
  return checkFiniteStateSafety<State>({
    initial: [initial],
    key: (state) => JSON.stringify(state),
    next(state) {
      const steps: ModelStep<State>[] = [];
      function add(action: string, allowed: boolean, update: Partial<State>) {
        if (allowed) steps.push({ action, state: { ...state, ...update } });
      }
      add('register member', !state.member, { member: true });
      add('provision NHI', state.nhi === 'absent' && (state.member || bypass === 'owner'), {
        nhi: 'provisioned',
      });
      add('review plan', state.nhi === 'provisioned' && state.authority === 'absent', {
        authority: 'reviewed',
      });
      add('approve plan', state.authority === 'reviewed', { authority: 'approved' });
      add(
        'activate NHI',
        state.nhi === 'provisioned' && (state.authority === 'approved' || bypass === 'activation'),
        { nhi: 'active' }
      );
      add('bind tenant', state.member && state.tenant === 'unbound', { tenant: 'bound' });
      add('pass tenant probes', state.tenant === 'bound', { tenant: 'probed' });
      add('accept tenant plan', state.tenant === 'probed', { tenant: 'accepted' });
      add(
        'activate tenant',
        !state.tenantActive &&
          (state.tenant === 'accepted' || (state.tenant !== 'unbound' && bypass === 'tenant')),
        { tenantActive: true }
      );
      add(
        'register customer actor',
        state.tenant !== 'unbound' && state.customer === 'unregistered',
        {
          customer: 'registered',
        }
      );
      add('record customer evidence', state.customer === 'registered', { customer: 'evidenced' });
      add(
        'decide customer value',
        !state.customerDecided &&
          (state.customer === 'evidenced' ||
            (state.customer === 'registered' && bypass === 'customer')),
        { customerDecided: true }
      );
      return steps;
    },
    invariants: {
      accountableMember: (state) => state.nhi === 'absent' || state.member,
      approvedActivation: (state) => state.nhi !== 'active' || state.authority === 'approved',
      acceptedTenantProof: (state) => !state.tenantActive || state.tenant === 'accepted',
      evidencedCustomerDecision: (state) =>
        !state.customerDecided || (state.tenant !== 'unbound' && state.customer === 'evidenced'),
    },
  });
}

it('checks every reachable fresh onboarding state', () => {
  expect(checkOnboarding()).toMatchObject({ status: 'verified', visited: 86, transitions: 194 });
});

it.each([
  ['owner', 'accountableMember', ['provision NHI']],
  ['activation', 'approvedActivation', ['register member', 'provision NHI', 'activate NHI']],
  ['tenant', 'acceptedTenantProof', ['register member', 'bind tenant', 'activate tenant']],
  [
    'customer',
    'evidencedCustomerDecision',
    ['register member', 'bind tenant', 'register customer actor', 'decide customer value'],
  ],
] satisfies [Bypass, string, string[]][])(
  'finds a counterexample for the %s bypass',
  (bypass, invariant, actions) => {
    const result = checkOnboarding(bypass);
    expect(result).toMatchObject({ status: 'violated', invariant });
    expect(result.trace?.map(({ action }) => action)).toEqual(['initial', ...actions]);
  }
);
