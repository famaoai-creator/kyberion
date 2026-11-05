import { describe, expect, it } from 'vitest';
import {
  inboxHrefForApproval,
  inboxReturnToCandidateHref,
  libraryHrefForKnowledgeCandidate,
} from './inbox-links';
import { learningReviewHref } from './ops/knowledge-learning-client';

describe('inbox deep links (one producer for ?request=)', () => {
  it('addresses one approval card, encoding every value', () => {
    expect(inboxHrefForApproval('APR 1&x=y')).toBe('/inbox?reason=approval&request=APR+1%26x%3Dy');
    expect(inboxHrefForApproval('APR-1', { missionId: 'MSN-1', tenant: 'acme' })).toBe(
      '/inbox?reason=approval&request=APR-1&mission=MSN-1&tenant=acme'
    );
  });

  it('keeps the organization / project selection across the move', () => {
    const href = inboxHrefForApproval('APR-1', {
      storageChannel: 'terminal',
      candidateKey: 'k1',
      selection: { tenant_slug: 'acme', organization_id: 'sales', project_id: 'launch' },
    });
    const query = new URLSearchParams(href.split('?')[1]);
    expect(query.get('storageChannel')).toBe('terminal');
    expect(query.get('candidateKey')).toBe('k1');
    expect(query.get('organization_id')).toBe('sales');
    expect(query.get('project_id')).toBe('launch');
  });

  it('offers the way back to the knowledge candidate an approval was opened from', () => {
    const href = learningReviewHref('terminal:req-42', 'cand.key-1', 'acme', {
      tenant_slug: 'acme',
      organization_id: 'sales',
    })!;
    const back = inboxReturnToCandidateHref(href.slice(href.indexOf('?')));
    expect(back).toBe(
      libraryHrefForKnowledgeCandidate('cand.key-1', undefined, {
        tenant_slug: 'acme',
        organization_id: 'sales',
      })
    );
    expect(back).toContain('/library?tab=knowledge&candidateKey=cand.key-1');
    expect(back).toContain('organization_id=sales');
  });

  it('offers no return link without a candidate, without a request, or for a hostile key', () => {
    expect(inboxReturnToCandidateHref('?reason=approval&request=APR-1')).toBeNull();
    expect(inboxReturnToCandidateHref('?candidateKey=k1')).toBeNull();
    expect(
      inboxReturnToCandidateHref(
        '?request=APR-1&candidateKey=' + encodeURIComponent('https://evil.test/')
      )
    ).toBeNull();
  });
});
