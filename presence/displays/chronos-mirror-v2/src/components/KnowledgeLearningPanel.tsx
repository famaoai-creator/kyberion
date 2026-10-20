'use client';

import * as React from 'react';
import { Badge, Button, Callout, KeyValue } from '@agent/shared-ui';
import { WsPreformatted, WsTextareaField } from './ChronosWsParts';
import { uxText, type SupportedLocale } from '../lib/ux-vocabulary';
import type {
  ClientKnowledgeCandidate,
  ClientKnowledgeCuration,
  ClientLearningState,
} from '../lib/knowledge-response';
import {
  learningReviewHref,
  learningScopeSupported,
  type LearningAction,
} from '../lib/knowledge-learning-client';

const labels: Record<ClientLearningState, string> = {
  unsupported: 'chronos_learning_unsupported',
  draft: 'chronos_learning_draft',
  pending: 'chronos_learning_pending',
  approved: 'chronos_learning_approved',
  rejected: 'chronos_learning_rejected',
  expired: 'chronos_learning_expired',
  revoked: 'chronos_learning_revoked',
  published: 'chronos_learning_published',
  error: 'chronos_learning_error',
};
export function learningStateLabel(state: ClientLearningState, locale: SupportedLocale): string {
  return uxText(labels[state], locale);
}

export function KnowledgeLearningPanel({
  candidate,
  locale,
  localAdmin,
  disabled,
  onAction,
  onReject,
}: {
  candidate: ClientKnowledgeCandidate;
  locale: SupportedLocale;
  localAdmin: boolean;
  disabled: boolean;
  onAction: (action: LearningAction, curation?: ClientKnowledgeCuration) => void;
  onReject?: () => void;
}) {
  const learning = candidate.learning!;
  const saved = candidate.curation;
  const [title, setTitle] = React.useState(saved?.title || '');
  const [summary, setSummary] = React.useState(saved?.summary || candidate.summary);
  const [content, setContent] = React.useState(saved?.content || candidate.summary);
  const [evidence, setEvidence] = React.useState(
    (saved?.evidence_refs || candidate.evidence_refs).join('\n')
  );
  const curation: ClientKnowledgeCuration = {
    title: title.trim(),
    summary: summary.trim(),
    content: content.trim(),
    evidence_refs: evidence
      .split('\n')
      .map((ref) => ref.trim())
      .filter(Boolean),
  };
  const dirty = JSON.stringify(curation) !== JSON.stringify(saved);
  const valid = Boolean(
    curation.title && curation.summary && curation.content && curation.evidence_refs.length
  );
  const supported = learningScopeSupported(candidate) && learning.state !== 'unsupported';
  const editable = supported && learning.state === 'draft' && !learning.approvalRef;
  const blocked = disabled || !localAdmin || !supported || !learning.payloadDigest;
  const reviewHref = learning.approvalRef
    ? learningReviewHref(learning.approvalRef, candidate.candidateKey, candidate.tenantSlug)
    : null;
  return (
    <div className="grid gap-4">
      <Badge
        label={learningStateLabel(learning.state, locale)}
        tone={
          learning.state === 'published'
            ? 'success'
            : learning.state === 'approved'
              ? 'accent'
              : 'neutral'
        }
      />
      <p className="kb-text kb-text--muted">{uxText('chronos_learning_no_authority', locale)}</p>
      <KeyValue
        items={[
          {
            label: uxText('chronos_tenant_data_level', locale),
            value: candidate.scope?.tier || '-',
          },
          {
            label: uxText('chronos_tenant', locale),
            value: candidate.scope?.tenant_slug || '-',
            mono: true,
          },
          {
            label: uxText('chronos_learning_organization', locale),
            value: candidate.scope?.organization_id || '-',
            mono: true,
          },
          {
            label: uxText('chronos_project', locale),
            value: candidate.scope?.project_id || '-',
            mono: true,
          },
        ]}
      />
      {!supported ? (
        <Callout
          tone="warning"
          title={uxText('chronos_learning_unsupported', locale)}
          body={uxText('chronos_learning_scope_unchanged', locale)}
        />
      ) : null}
      {learning.reason ? <p className="kb-text kb-text--muted">{learning.reason}</p> : null}
      {editable && localAdmin ? (
        <fieldset
          disabled={blocked}
          className="grid gap-3"
          style={{ border: 0, padding: 0, margin: 0 }}
        >
          <legend className="chronos-feed__title">
            {uxText('chronos_learning_edit_draft', locale)}
          </legend>
          <WsTextareaField
            id="learning-title"
            label={uxText('chronos_learning_title', locale)}
            value={title}
            onChange={setTitle}
            rows={1}
          />
          <WsTextareaField
            id="learning-summary"
            label={uxText('chronos_learning_summary', locale)}
            value={summary}
            onChange={setSummary}
            rows={2}
          />
          <WsTextareaField
            id="learning-content"
            label={uxText('chronos_learning_content', locale)}
            value={content}
            onChange={setContent}
            rows={8}
          />
          <WsTextareaField
            id="learning-evidence"
            label={uxText('chronos_learning_evidence', locale)}
            value={evidence}
            onChange={setEvidence}
            rows={3}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              label={uxText('chronos_learning_save', locale)}
              variant="secondary"
              disabled={blocked || !dirty || !valid}
              onClick={() => onAction('memory_curate_candidate', curation)}
            />
            <Button
              label={uxText('chronos_learning_request', locale)}
              variant="primary"
              disabled={blocked || dirty || !saved}
              onClick={() => onAction('memory_request_learning_approval')}
            />
          </div>
          {dirty ? (
            <p className="kb-text kb-text--muted">{uxText('chronos_learning_unsaved', locale)}</p>
          ) : null}
        </fieldset>
      ) : saved ? (
        <div className="grid gap-2">
          <h3 className="chronos-feed__title">{saved.title}</h3>
          <p className="kb-text kb-text--body">{saved.summary}</p>
          <WsPreformatted text={saved.content} title={uxText('chronos_learning_content', locale)} />
          <WsPreformatted
            text={saved.evidence_refs.join('\n')}
            title={uxText('chronos_learning_evidence', locale)}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {onReject && ['queued', 'approved'].includes(candidate.status) ? (
          <Button
            label={uxText('chronos_reject_candidate', locale)}
            variant="danger"
            disabled={disabled || !localAdmin}
            onClick={onReject}
          />
        ) : null}
        {reviewHref ? (
          <a className="kb-link" href={reviewHref}>
            {uxText('chronos_learning_open_review', locale)}
          </a>
        ) : null}
        {learning.state === 'approved' ? (
          <Button
            label={uxText('chronos_learning_publish', locale)}
            variant="primary"
            disabled={blocked}
            onClick={() => onAction('memory_publish_learning')}
          />
        ) : null}
      </div>
      {learning.state === 'approved' ? (
        <p className="kb-text kb-text--muted">{uxText('chronos_learning_not_published', locale)}</p>
      ) : null}
      {['rejected', 'expired', 'revoked'].includes(learning.state) ? (
        <p className="kb-text kb-text--muted">{uxText('chronos_learning_new_candidate', locale)}</p>
      ) : null}
      {learning.publication ? (
        <KeyValue
          items={[
            {
              label: uxText('chronos_learning_destination', locale),
              value: learning.publication.markdown_path,
              mono: true,
            },
            {
              label: uxText('chronos_learning_content_hash', locale),
              value: learning.publication.markdown_sha256,
              mono: true,
            },
          ]}
        />
      ) : null}
    </div>
  );
}
