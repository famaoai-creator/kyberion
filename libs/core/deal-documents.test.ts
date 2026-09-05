import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from './authority.js';
import { advanceDealStage, openDeal } from './deal-store.js';
import {
  draftContractForDeal,
  generateQuoteForDeal,
  loadContractReviewAtPath,
  recordContractReview,
} from './deal-documents.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

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

  it('rejects an invalid review before persisting it', () => {
    const filePath = pathResolver.rootResolve(
      `customer/${TENANT}/deals/${DEAL_ID}/contract-review-v1.json`
    );
    expect(() =>
      withExecutionContext('mission_controller', () =>
        recordContractReview({
          tenantSlug: TENANT,
          dealId: DEAL_ID,
          version: 1,
          verdict: 'approve',
          reviewer: '',
        })
      )
    ).toThrow(/Invalid catalog contract-review-record/);
    expect(safeExistsSync(filePath)).toBe(false);
  });

  it('rejects a directory at the review record path', () => {
    const filePath = pathResolver.rootResolve(
      `customer/${TENANT}/deals/${DEAL_ID}/contract-review-v1.json`
    );
    withExecutionContext('mission_controller', () => safeMkdir(filePath, { recursive: true }));

    expect(() => loadContractReviewAtPath(filePath, TENANT, DEAL_ID, 1)).toThrow('regular file');
  });

  it('rejects a directory used as a contract template', () => {
    const knowledgeRoot = pathResolver.sharedTmp('deal-documents-template-test');
    const templatePath = path.join(knowledgeRoot, 'templates', 'contract.md');
    const knowledgeSpy = vi
      .spyOn(pathResolver, 'knowledge')
      .mockImplementation((subPath = '') => path.join(knowledgeRoot, subPath));
    safeMkdir(templatePath, { recursive: true });

    try {
      const deal = withExecutionContext('mission_controller', () =>
        openDeal({
          tenantSlug: TENANT,
          surface: 'test',
          channelId: 'channel-template',
          summary: 'contract template boundary test',
        })
      );
      withExecutionContext('mission_controller', () =>
        advanceDealStage({
          tenantSlug: TENANT,
          dealId: deal.deal_id,
          stage: 'quote',
          agreed: {
            scope: ['template boundary'],
            amount: { value: 1000, currency: 'JPY' },
          },
        })
      );

      expect(() =>
        withExecutionContext('mission_controller', () =>
          draftContractForDeal({
            tenantSlug: TENANT,
            dealId: deal.deal_id,
            templatePath: 'templates/contract.md',
          })
        )
      ).toThrow('contract_template_must_be_a_regular_file');
    } finally {
      safeRmSync(knowledgeRoot, { recursive: true, force: true });
      knowledgeSpy.mockRestore();
    }
  });

  it('persists deterministic quotes through the quote schema boundary', () => {
    const deal = withExecutionContext('mission_controller', () =>
      openDeal({
        tenantSlug: TENANT,
        surface: 'test',
        channelId: 'channel-quote',
        summary: 'quote schema test',
      })
    );

    const result = withExecutionContext('mission_controller', () =>
      generateQuoteForDeal({
        tenantSlug: TENANT,
        dealId: deal.deal_id,
        requests: [
          {
            task_kind: 'document_production',
            size: 'S',
            description: 'schema-bound proposal',
          },
        ],
      })
    );

    expect(result.ok).toBe(true);
    const quotePath = pathResolver.rootResolve(
      `customer/${TENANT}/deals/${deal.deal_id}/quote-v1.json`
    );
    const stored = JSON.parse(String(safeReadFile(quotePath)));
    expect(stored.ok).toBe(true);
    expect(stored.currency).toBe('JPY');
    expect(stored.$schema).toBeUndefined();
  });
});
