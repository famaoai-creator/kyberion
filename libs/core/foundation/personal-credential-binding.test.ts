import { afterEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import {
  assertCredentialOwner,
  credentialBindingReadiness,
  credentialExecutionIdentity,
  resolveTaskCredential,
  resolveTaskProviderEnvironment,
  selectProviderCredential,
  withPersonalTaskCredentialBinding,
  withTaskCredentialBinding,
} from './credential-binding.js';

const claim = {
  ownerId: 'user:alice',
  actorId: 'kyberion://agent/_/_/personal',
  workItemId: 'WI-PERSONAL',
  attemptId: 'run-1',
  leaseId: 'lease-1',
};
const scope = <T>(run: () => T, taskId = 'task-a') =>
  withExecutionContext('infrastructure_sentinel', run, undefined, '', undefined, {
    missionId: 'MSN-PERSONAL',
    taskId,
  });
afterEach(() => vi.unstubAllEnvs());

describe('empty personal task credential binding', () => {
  it('separates a claimed personal execution from operator values and restores the caller', () => {
    const operator = credentialExecutionIdentity();
    scope(() =>
      withPersonalTaskCredentialBinding(
        claim,
        () => {},
        () => {
          expect(credentialBindingReadiness().status).toBe('bound');
          expect(credentialExecutionIdentity().personalClaim).toEqual(claim);
          expect(resolveTaskCredential('TEST_KEY')).toBeNull();
          expect(selectProviderCredential(['TEST_KEY'], 'operator')).toBeUndefined();
          expect(() => resolveTaskProviderEnvironment('gws')).toThrow('CREDENTIAL_PROVIDER_DENIED');
          expect(() => assertCredentialOwner(operator)).toThrow('CREDENTIAL_OWNER_DENIED');
        }
      )
    );
    expect(credentialExecutionIdentity()).toEqual(operator);
    expect(resolveTaskCredential('TEST_KEY')).toBeUndefined();
  });

  it('revalidates lease/owner proof for reads and cached-client use', () => {
    let live = true;
    const validate = () => {
      if (!live) throw new Error('claim expired');
    };
    scope(() =>
      withPersonalTaskCredentialBinding(claim, validate, () => {
        const owner = credentialExecutionIdentity();
        expect(resolveTaskCredential('TEST_KEY')).toBeNull();
        live = false;
        expect(() => resolveTaskCredential('TEST_KEY')).toThrow('claim expired');
        expect(() => assertCredentialOwner(owner)).toThrow('claim expired');
      })
    );
  });

  it('rejects scope drift, claim replacement and credential widening', () => {
    const validate = () => {};
    scope(() =>
      withPersonalTaskCredentialBinding(claim, validate, () => {
        expect(() => scope(() => resolveTaskCredential('TEST_KEY'), 'task-b')).toThrow(
          'CREDENTIAL_SCOPE_DENIED'
        );
        for (const field of ['ownerId', 'actorId', 'workItemId', 'attemptId', 'leaseId'] as const) {
          expect(() =>
            withPersonalTaskCredentialBinding({ ...claim, [field]: 'other' }, validate, () => {})
          ).toThrow('CREDENTIAL_SCOPE_DENIED');
        }
        expect(() =>
          withTaskCredentialBinding(
            { personalClaim: claim, secrets: { TEST_KEY: 'value' }, validate },
            () => {}
          )
        ).toThrow('empty binding only');
        expect(() =>
          withTaskCredentialBinding(
            { personalClaim: claim, secrets: {}, providerEnvironments: {}, validate },
            () => {}
          )
        ).toThrow('empty binding only');
        expect(() => withTaskCredentialBinding({ secrets: {} }, () => {})).toThrow(
          'CREDENTIAL_SCOPE_DENIED'
        );
      })
    );
  });

  it('isolates concurrent claims and denies clients carried to another attempt', async () => {
    let first: ReturnType<typeof credentialExecutionIdentity>;
    await scope(() =>
      withPersonalTaskCredentialBinding(
        claim,
        () => {},
        async () => {
          first = credentialExecutionIdentity();
          await Promise.resolve();
        }
      )
    );
    await Promise.all(
      ['run-2', 'run-3'].map((attemptId) =>
        scope(() =>
          withPersonalTaskCredentialBinding(
            { ...claim, attemptId },
            () => {},
            async () => {
              await Promise.resolve();
              expect(credentialExecutionIdentity().personalClaim?.attemptId).toBe(attemptId);
              expect(() => assertCredentialOwner(first)).toThrow('CREDENTIAL_OWNER_DENIED');
            }
          )
        )
      )
    );
  });
});

describe('personal selected operation overlay', () => {
  it('requires exact provenance, denies ambient/provider and expires captured async work', async () => {
    const { withPersonalServiceCredentialBinding, resolveTaskServiceCredential } =
      await import('./credential-binding.js');
    const source = {
      serviceBindingId: 'slack-personal',
      serviceId: 'slack',
      sourceOwnerRef: claim.ownerId,
      personalGrantId: 'GRT-20261114-123456789abc',
      generation: 'generation',
      secrets: { SLACK_TOKEN: 'synthetic-token' },
      validate: () => {
        if (!live) throw new Error('revoked');
      },
    };
    let live = true;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let escaped: Promise<void> | undefined;
    await scope(() =>
      withPersonalTaskCredentialBinding(
        claim,
        () => {},
        () =>
          withPersonalServiceCredentialBinding(source, async () => {
            expect(resolveTaskCredential('SLACK_TOKEN')).toBeNull();
            expect(resolveTaskServiceCredential('SLACK_TOKEN', source)).toBe('synthetic-token');
            expect(() =>
              resolveTaskServiceCredential('SLACK_TOKEN', { ...source, generation: 'other' })
            ).toThrow();
            expect(() => resolveTaskProviderEnvironment('gws')).toThrow();
            await expect(
              withPersonalServiceCredentialBinding(source, async () => {})
            ).rejects.toThrow();
            escaped = barrier.then(() => {
              expect(() => resolveTaskServiceCredential('SLACK_TOKEN', source)).toThrow();
            });
            live = false;
            expect(() => resolveTaskServiceCredential('SLACK_TOKEN', source)).toThrow('revoked');
            live = true;
          })
      )
    );
    release();
    await escaped;
  });
});
