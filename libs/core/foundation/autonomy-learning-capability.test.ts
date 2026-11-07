import { describe, expect, it } from 'vitest';
import {
  autonomyLearningCapability,
  isAutonomyLearningCapability,
  withAutonomyLearningCapability,
} from './autonomy-learning-capability.js';
import {
  createSynchronousResourceGrantIssuer,
  currentResourceAccessScope,
  runInResourceAccessScope,
} from './resource-access-scope.js';

const TENANT = 'tenant-a';
const DIRECTORY = 'active/shared/runtime/autonomy-learning/confidential/' + TENANT;
const live = () => isAutonomyLearningCapability(currentResourceAccessScope());

describe('autonomy learning grant (G2: module-private, unforgeable)', () => {
  it('resolves only the live grant of its own issuer', () => {
    expect(withAutonomyLearningCapability(TENANT, DIRECTORY, live)).toBe(true);
    expect(live()).toBe(false);
  });

  it('refuses a structural lookalike, a copy and a counterfeit issuer', () => {
    expect(runInResourceAccessScope(autonomyLearningCapability(TENANT), live)).toBe(false);
    withAutonomyLearningCapability(TENANT, DIRECTORY, () => {
      const issued = currentResourceAccessScope()!;
      expect(isAutonomyLearningCapability({ ...issued })).toBe(false);
      expect(isAutonomyLearningCapability(Object.freeze(Object.create(issued)))).toBe(false);
      // A nested ceiling replaces the issued scope, so the grant no longer resolves.
      expect(runInResourceAccessScope({ ...issued }, live)).toBe(false);
    });
    const counterfeit = createSynchronousResourceGrantIssuer<object>(
      'AUTONOMY_LEARNING_CAPABILITY'
    );
    expect(counterfeit.run({}, autonomyLearningCapability(TENANT), live)).toBe(false);
  });

  it('refuses an issued grant whose ceiling does not match its binding', () => {
    expect(() =>
      withAutonomyLearningCapability(TENANT, 'active/shared/runtime/autonomy-learning', live)
    ).toThrow('RESOURCE_SCOPE_INVALID');
    expect(() => withAutonomyLearningCapability('Not A Tenant', DIRECTORY, live)).toThrow(
      'RESOURCE_SCOPE_INVALID'
    );
  });

  it('is synchronous: no escape, no thenable, no captured continuation', async () => {
    expect(() =>
      withAutonomyLearningCapability(TENANT, DIRECTORY, () => currentResourceAccessScope())
    ).toThrow('AUTONOMY_LEARNING_CAPABILITY_ESCAPE');
    expect(() =>
      withAutonomyLearningCapability(TENANT, DIRECTORY, () => Promise.resolve(true))
    ).toThrow('AUTONOMY_LEARNING_CAPABILITY_ASYNC');
    let later: Promise<boolean> | undefined;
    withAutonomyLearningCapability(TENANT, DIRECTORY, () => {
      later = new Promise((resolve) => setTimeout(() => resolve(live()), 0));
    });
    await expect(later).resolves.toBe(false);
  });
});
