import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ overrides: new Map<string, Record<string, unknown>>() }));
vi.mock('../foundation/authorization-registry.js', async (original) => {
  const actual = await original<typeof import('../foundation/authorization-registry.js')>();
  return {
    ...actual,
    subjectAuthorization: (subject: string) => ({
      ...actual.subjectAuthorization(subject),
      ...state.overrides.get(subject),
    }),
  };
});
import { assertInformationAssetCatalogAuthorization } from './access.js';
import { informationAssetCoverageReadAllowed } from '../foundation/information-asset-coverage-access.js';
import { withExecutionContext } from '../authority.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';
import { withConciergeManagementAccess } from '../surface/concierge-management-access.js';
import { subjectAuthorization } from '../foundation/authorization-registry.js';
import {
  serializeRegistryDocument,
  evaluatePolicyDocument,
  normalizeAuthorizationRequest,
  cedarDocumentText,
} from '../foundation/authorization-policy-document.js';
const read = 'information-asset:catalog:read';
const write = 'information-asset:catalog:write';
const coverage = 'information-asset:coverage:read';
const viewer = 'chronos.information-assets.read';
const checkpoint =
  'active/shared/runtime/dot/confidential/acme/organizations/org-a/information-assets/collections/mail.json';
beforeEach(() => state.overrides.clear());
describe('information asset canonical authorization subjects', () => {
  it('serializes exact code subjects into the Cedar form with the matching authority', () => {
    const document = serializeRegistryDocument();
    for (const subject of [read, write, coverage, viewer]) {
      expect(subjectAuthorization(subject)).toMatchObject({
        declared: true,
        source: 'code',
        axis: 'operation',
      });
      expect(document.policies.find((policy) => policy.subject === subject)).toMatchObject({
        match: 'exact',
        provenance: { source: 'code' },
      });
      expect(cedarDocumentText(document)).toContain(subject);
    }
    const request = (subject: string, admissionGranted?: 'internal') =>
      normalizeAuthorizationRequest({
        principal: { id: 'user:owner' },
        action: { subject },
        context: { ...(admissionGranted ? { admissionGranted } : {}) },
      });
    expect(evaluatePolicyDocument(document, request(write)).kind).toBe('require_approval');
    expect(evaluatePolicyDocument(document, request(write, 'internal')).kind).toBe('permit');
    expect(evaluatePolicyDocument(document, request(read)).kind).toBe('permit');
  });
  it('requires supported declared paths instead of bypassing stronger requirements', () => {
    expect(() => assertInformationAssetCatalogAuthorization()).not.toThrow();
    expect(() => assertInformationAssetCatalogAuthorization(true)).not.toThrow();
    for (const change of [
      { declared: false },
      { source: 'overlay' },
      { effectClass: 'external_mutation' },
      { authority: { kind: 'approval', assurance: 'A3' } },
      { authority: { kind: 'binding', scope: 'tenant' } },
    ]) {
      state.overrides.set(read, change);
      expect(() => assertInformationAssetCatalogAuthorization()).toThrow('declared authority');
    }
    state.overrides.set(write, { authority: { kind: 'approval', dualKey: true } });
    expect(() => assertInformationAssetCatalogAuthorization(true)).toThrow('declared authority');
  });
  it('does not let a coverage resource capability override registry strengthening', () => {
    const allowed = () =>
      withConciergeManagementAccess(
        {
          tenantSlug: 'acme',
          organizationId: 'org-a',
          reads: [checkpoint],
          writes: [],
          mkdir: [],
          identity: { projectId: null },
        },
        () => informationAssetCoverageReadAllowed(checkpoint, undefined)
      );
    // G2/S4: the former role name alone admits nothing — it is a store grant now, so
    // assuming it is refused before any read.
    expect(() =>
      runInResourceAccessScope(
        {
          tenantSlug: 'acme',
          organizationId: 'org-a',
          readExact: [checkpoint],
          writeExact: [],
          mkdirExact: [],
        },
        () =>
          withExecutionContext(
            'concierge_management_reader',
            () => informationAssetCoverageReadAllowed(checkpoint, 'concierge_management_reader'),
            undefined,
            'acme',
            'org-a',
            { projectId: null }
          )
      )
    ).toThrow(/ROLE_ASSUMPTION_DENIED/);
    expect(allowed()).toBe(true);
    state.overrides.set(coverage, { authority: { kind: 'approval' } });
    expect(allowed()).toBe(false);
  });
});
