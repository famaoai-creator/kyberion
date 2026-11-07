import { describe, expect, it } from 'vitest';
import {
  customerDecisionConsumerCapability,
  isCustomerDecisionConsumerCapability,
  runInCustomerDecisionConsumerSweep,
  withCustomerDecisionConsumerCapability,
} from './customer-decision-consumer-capability.js';
import {
  createSynchronousResourceGrantIssuer,
  currentResourceAccessScope,
  runInResourceAccessScope,
} from './resource-access-scope.js';

const TENANT = 'tenant-a';
const CASE = `knowledge/confidential/${TENANT}/decisions/case-1`;
const access = {
  read: ['decisions.jsonl'],
  write: 'consumers/mission-MSN-X.t.json',
  owner: 'mission-MSN-X.t',
};
const live = () => isCustomerDecisionConsumerCapability(currentResourceAccessScope());

describe('customer decision consumer grant (G2: module-private, unforgeable)', () => {
  it('resolves only the live grant of its own issuer', () => {
    expect(withCustomerDecisionConsumerCapability(TENANT, CASE, access, live)).toBe(true);
    expect(live()).toBe(false);
    expect(
      runInResourceAccessScope(customerDecisionConsumerCapability(TENANT, CASE, access), live)
    ).toBe(false);
    withCustomerDecisionConsumerCapability(TENANT, CASE, access, () => {
      const issued = currentResourceAccessScope()!;
      expect(isCustomerDecisionConsumerCapability({ ...issued })).toBe(false);
      expect(runInResourceAccessScope({ ...issued }, live)).toBe(false);
    });
    const counterfeit = createSynchronousResourceGrantIssuer<object>(
      'CUSTOMER_DECISION_CONSUMER_CAPABILITY'
    );
    expect(
      counterfeit.run({}, customerDecisionConsumerCapability(TENANT, CASE, access), live)
    ).toBe(false);
  });

  it('keeps the sweep kind inside the sweep', () => {
    const sweep = {
      read: ['consumers', 'consumers/mission-MSN-X.a.json', 'consumers/mission-MSN-X.b.json'],
    };
    expect(() => withCustomerDecisionConsumerCapability(TENANT, CASE, sweep, live)).toThrow(
      'Only the customer decision consumer sweep'
    );
    expect(
      runInCustomerDecisionConsumerSweep(() =>
        withCustomerDecisionConsumerCapability(TENANT, CASE, sweep, live)
      )
    ).toBe(true);
  });

  it('is synchronous: no escape, no thenable, no captured continuation', async () => {
    expect(() =>
      withCustomerDecisionConsumerCapability(TENANT, CASE, access, () =>
        currentResourceAccessScope()
      )
    ).toThrow('CUSTOMER_DECISION_CONSUMER_CAPABILITY_ESCAPE');
    expect(() =>
      withCustomerDecisionConsumerCapability(TENANT, CASE, access, () => Promise.resolve(true))
    ).toThrow('CUSTOMER_DECISION_CONSUMER_CAPABILITY_ASYNC');
    let later: Promise<boolean> | undefined;
    withCustomerDecisionConsumerCapability(TENANT, CASE, access, () => {
      later = new Promise((resolve) => setTimeout(() => resolve(live()), 0));
    });
    await expect(later).resolves.toBe(false);
  });
});
