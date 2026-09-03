import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from './authority.js';
import { loadContractReviewAtPath, recordContractReview } from './deal-documents.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

const TENANT = 'deal-review-loader-test';
const DEAL_ID = 'DEAL-REVIEW-001';
const DEAL_ROOT = pathResolver.rootResolve(`customer/${TENANT}`);

afterEach(() => {
  withExecutionContext('mission_controller', () =>
    safeRmSync(DEAL_ROOT, { recursive: true, force: true })
  );
});

describe('deal document contract review loader', () => {
  it('loads a review record through the schema and exact deal/version binding', () => {
    const filePath = withExecutionContext('mission_controller', () =>
      recordContractReview({
        tenantSlug: TENANT,
        dealId: DEAL_ID,
        version: 2,
        verdict: 'approve',
        reviewer: 'operator',
        notes: 'approved for delivery',
      })
    );

    expect(loadContractReviewAtPath(filePath, TENANT, DEAL_ID, 2)).toMatchObject({
      verdict: 'approve',
      deal_id: DEAL_ID,
      version: 2,
    });
  });

  it('rejects a review record bound to another deal or version', () => {
    const filePath = pathResolver.rootResolve(
      `customer/${TENANT}/deals/${DEAL_ID}/contract-review-v2.json`
    );
    withExecutionContext('mission_controller', () => {
      safeMkdir(path.dirname(filePath), { recursive: true });
      safeWriteFile(
        filePath,
        JSON.stringify({
          kind: 'contract-review-record',
          deal_id: 'DEAL-OTHER-001',
          version: 2,
          verdict: 'approve',
          reviewer: 'operator',
          notes: '',
          reviewed_at: '2026-09-03T00:00:00.000Z',
        })
      );
    });

    expect(() => loadContractReviewAtPath(filePath, TENANT, DEAL_ID, 2)).toThrow(
      'binding mismatch'
    );
  });

  it('rejects a directory at the review record path', () => {
    const filePath = pathResolver.rootResolve(
      `customer/${TENANT}/deals/${DEAL_ID}/contract-review-v1.json`
    );
    withExecutionContext('mission_controller', () => safeMkdir(filePath, { recursive: true }));

    expect(() => loadContractReviewAtPath(filePath, TENANT, DEAL_ID, 1)).toThrow('regular file');
  });
});
