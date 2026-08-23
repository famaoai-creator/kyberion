import { describe, expect, it } from 'vitest';
import {
  HeadlessQueryError,
  readHeadlessCollaboration,
  readHeadlessWorkItems,
} from './headless-projections';

const viewer = {
  role: 'readonly' as const,
  tenantSlugs: ['tenant-a'],
  organizationIds: ['org-a'],
  projectIds: ['project-a'],
  tierAccess: ['public'],
  source: 'token' as const,
  principalId: 'viewer-a',
};

describe('headless projection validation', () => {
  it('rejects unknown work-items scope and view values', () => {
    expect(() => readHeadlessWorkItems(viewer, { scope: 'unknown' })).toThrow(HeadlessQueryError);
    expect(() => readHeadlessWorkItems(viewer, { view: 'unknown' })).toThrow(HeadlessQueryError);
  });

  it('rejects unknown collaboration scope kinds', () => {
    expect(() => readHeadlessCollaboration(viewer, { scopeKind: 'unknown' })).toThrow(
      HeadlessQueryError
    );
  });
});
