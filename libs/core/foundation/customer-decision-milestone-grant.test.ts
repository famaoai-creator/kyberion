import { describe, expect, it } from 'vitest';
import {
  customerDecisionMilestoneCapability,
  isCustomerDecisionMilestoneCapability,
  withCustomerDecisionMilestoneCapability,
} from './customer-decision-milestone-capability.js';
import {
  createSynchronousResourceGrantIssuer,
  currentResourceAccessScope,
  runInResourceAccessScope,
} from './resource-access-scope.js';

const TENANT = 'tenant-a';
const CASE = `knowledge/confidential/${TENANT}/decisions/case-1`;
const access = { read: ['agendas'], write: 'agendas/agd-review0001.json' };
const live = () => isCustomerDecisionMilestoneCapability(currentResourceAccessScope());

describe('customer decision milestone grant (G2: module-private, unforgeable)', () => {
  it('resolves only the live grant of its own issuer', () => {
    expect(withCustomerDecisionMilestoneCapability(TENANT, CASE, access, live)).toBe(true);
    expect(live()).toBe(false);
    expect(
      runInResourceAccessScope(customerDecisionMilestoneCapability(TENANT, CASE, access), live)
    ).toBe(false);
    withCustomerDecisionMilestoneCapability(TENANT, CASE, access, () => {
      const issued = currentResourceAccessScope()!;
      expect(isCustomerDecisionMilestoneCapability({ ...issued })).toBe(false);
      expect(runInResourceAccessScope({ ...issued }, live)).toBe(false);
    });
    const counterfeit = createSynchronousResourceGrantIssuer<object>(
      'CUSTOMER_DECISION_MILESTONE_CAPABILITY'
    );
    expect(
      counterfeit.run({}, customerDecisionMilestoneCapability(TENANT, CASE, access), live)
    ).toBe(false);
  });

  it('is synchronous: no escape, no thenable, no captured continuation', async () => {
    expect(() =>
      withCustomerDecisionMilestoneCapability(TENANT, CASE, access, () =>
        currentResourceAccessScope()
      )
    ).toThrow('CUSTOMER_DECISION_MILESTONE_CAPABILITY_ESCAPE');
    expect(() =>
      withCustomerDecisionMilestoneCapability(TENANT, CASE, access, () => Promise.resolve(true))
    ).toThrow('CUSTOMER_DECISION_MILESTONE_CAPABILITY_ASYNC');
    let later: Promise<boolean> | undefined;
    withCustomerDecisionMilestoneCapability(TENANT, CASE, access, () => {
      later = new Promise((resolve) => setTimeout(() => resolve(live()), 0));
    });
    await expect(later).resolves.toBe(false);
  });
});
