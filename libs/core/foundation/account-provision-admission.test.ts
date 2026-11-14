import { describe, expect, it } from 'vitest';
import {
  assertAccountIntroductionProvisioning,
  assertAccountProvisionRequest,
  withAccountProvisionAdmission,
  withAccountProvisionRequest,
  type AccountProvisionInput,
} from './account-provision-admission.js';

const input: AccountProvisionInput = Object.freeze({
  brokerId: 'fixture',
  reference: Object.freeze({
    serviceId: 'github',
    bindingId: 'binding',
    ownerKind: 'organization',
    ownerRef: 'acme',
    tenantSlug: 'acme',
    generation: 'generation',
  }),
  expectedGeneration: null,
  material: Object.freeze({ GITHUB_TOKEN: 'fixture-only' }),
});
describe('account provisioning admission lifetime', () => {
  it('admits only the exact live input and request and revokes both on return', async () => {
    const request = {};
    expect(() => assertAccountIntroductionProvisioning(input)).toThrow();
    await withAccountProvisionAdmission(input, async () => {
      assertAccountIntroductionProvisioning(input);
      expect(() => assertAccountIntroductionProvisioning({ ...input })).toThrow();
      await withAccountProvisionRequest(input, request, async () => {
        assertAccountProvisionRequest(request);
        expect(() => assertAccountProvisionRequest({})).toThrow();
      });
      expect(() => assertAccountProvisionRequest(request)).toThrow();
    });
    expect(() => assertAccountIntroductionProvisioning(input)).toThrow();
    expect(() => assertAccountProvisionRequest(request)).toThrow();
  });
  it('revokes the window even for a continuation captured before failure', async () => {
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let continuation!: Promise<void>;
    await expect(
      withAccountProvisionAdmission(input, async () => {
        continuation = waiting.then(() => {
          expect(() => assertAccountIntroductionProvisioning(input)).toThrow();
        });
        throw new Error('interrupted');
      })
    ).rejects.toThrow('interrupted');
    resume();
    await continuation;
  });
});
