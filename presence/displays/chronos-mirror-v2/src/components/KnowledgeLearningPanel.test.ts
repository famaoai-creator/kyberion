import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeLearningPanel } from './KnowledgeLearningPanel';
import type { ClientKnowledgeCandidate } from '../lib/knowledge-response';
const candidate: ClientKnowledgeCandidate = {
  candidate_id: 'CAND-1',
  candidateKey: 'a'.repeat(64),
  status: 'queued',
  proposed_memory_kind: 'sop',
  summary: 'Original lesson',
  evidence_refs: ['trace:one'],
  sensitivity_tier: 'confidential',
  source_ref: 'task_session:one',
  tenantSlug: 'acme',
  ratification_required: true,
  scope: {
    tier: 'confidential',
    tenant_slug: 'acme',
    organization_id: 'org-a',
    project_id: 'project-a',
  },
  curation: {
    title: 'Reviewed title',
    summary: 'Reviewed summary',
    content: 'Exact SOP text',
    evidence_refs: ['trace:one'],
  },
  learning: { state: 'draft', payloadDigest: 'b'.repeat(64) },
};
const render = (
  row = candidate,
  options: {
    locale?: 'ja' | 'en';
    localAdmin?: boolean;
    disabled?: boolean;
    onReject?: () => void;
  } = {}
) =>
  renderToStaticMarkup(
    createElement(KnowledgeLearningPanel, {
      candidate: row,
      locale: options.locale || 'en',
      localAdmin: options.localAdmin ?? true,
      disabled: options.disabled ?? false,
      onAction: vi.fn(),
      onReject: options.onReject,
    })
  );
describe('learning panel static markup (not rendered-browser interaction evidence)', () => {
  it.each(['queued', 'approved'] as const)(
    'permits rejecting %s unsupported scoped SOPs without offering positive authority',
    (status) => {
      const onReject = vi.fn();
      const unsupported: ClientKnowledgeCandidate = {
        ...candidate,
        status,
        scope: { ...candidate.scope!, owner_nhi: 'user:one' },
        learning: { state: 'unsupported' },
      };
      const html = render(unsupported, { onReject });
      const button = html
        .match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
        ?.find((item) => item.includes('Reject candidate'));
      expect(button).toBeDefined();
      expect(button).not.toContain('disabled');
      expect(html).not.toContain('Request human review');
      expect(html).not.toContain('Publish approved SOP');
      expect(html).not.toContain('Save draft');
      expect(onReject).not.toHaveBeenCalled();
      for (const options of [{ localAdmin: false }, { disabled: true }]) {
        const blocked = render(unsupported, { ...options, onReject });
        const reject = blocked
          .match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
          ?.find((item) => item.includes('Reject candidate'));
        expect(reject).toContain('disabled');
      }
      expect(render({ ...unsupported, status: 'rejected' }, { onReject })).not.toContain(
        'Reject candidate'
      );
    }
  );
  it('shows the exact scope and separate save/review controls without granting authority', () => {
    const html = render();
    expect(html).toContain('acme');
    expect(html).toContain('org-a');
    expect(html).toContain('project-a');
    expect(html).toContain('Exact SOP text');
    expect(html).toContain('Save draft');
    expect(html).toContain('Request human review');
    expect(html).toContain('no execution authority');
    expect(html).not.toContain('Publish approved SOP');
  });
  it('opens the canonical request without embedding another approval control', () => {
    const html = render({
      ...candidate,
      learning: {
        state: 'pending',
        payloadDigest: 'b'.repeat(64),
        approvalRef: 'terminal:approval-1',
      },
    });
    expect(html).toContain('Open shared review');
    expect(html).toContain('request=approval-1');
    expect(html).toContain('storageChannel=terminal');
    expect(html).toContain('candidateKey=');
    expect(html).not.toContain('Publish approved SOP');
    expect(html).not.toContain('Save draft');
  });
  it('requires an explicit publish action and never calls it while rendering', () => {
    const onAction = vi.fn();
    const html = renderToStaticMarkup(
      createElement(KnowledgeLearningPanel, {
        candidate: {
          ...candidate,
          learning: {
            state: 'approved',
            payloadDigest: 'b'.repeat(64),
            approvalRef: 'terminal:approval-1',
          },
        },
        locale: 'en',
        localAdmin: true,
        disabled: false,
        onAction,
      })
    );
    expect(html).toContain('Publish approved SOP');
    expect(html).toContain('has not been published yet');
    expect(onAction).not.toHaveBeenCalled();
  });
  it.each([{ owner_nhi: 'user:one' }, { allowed_audience: ['user:one'] }])(
    'keeps restricted scope read-only %j',
    (restriction) => {
      const html = render({ ...candidate, scope: { ...candidate.scope!, ...restriction } });
      expect(html).toContain('unsupported scope');
      expect(html).toContain('preserved, not removed');
      expect(html).not.toContain('Save draft');
      expect(html).not.toContain('Request human review');
    }
  );
  it('keeps readonly viewers and unconfirmed status from publishing', () => {
    const approved: ClientKnowledgeCandidate = {
      ...candidate,
      learning: {
        state: 'approved',
        payloadDigest: 'b'.repeat(64),
        approvalRef: 'terminal:approval-1',
      },
    };
    expect(render(approved, { localAdmin: false })).toContain('disabled=');
    expect(render(approved, { disabled: true })).toContain('disabled=');
  });
  it.each(['rejected', 'expired', 'revoked'] as const)(
    'retains a terminal %s review instead of offering a new request',
    (state) => {
      const html = render({
        ...candidate,
        learning: { state, payloadDigest: 'b'.repeat(64), approvalRef: 'terminal:approval-1' },
      });
      expect(html).toContain('new candidate is required');
      expect(html).not.toContain('Request human review');
      expect(html).not.toContain('Publish approved SOP');
    }
  );
  it('localizes the explicit steps and scope warning in Japanese', () => {
    expect(render(candidate, { locale: 'ja' })).toContain('下書きを保存');
    expect(render(candidate, { locale: 'ja' })).toContain('人間による確認を依頼');
    expect(render(candidate, { locale: 'ja' })).toContain('実行権限は付与されません');
  });
});
