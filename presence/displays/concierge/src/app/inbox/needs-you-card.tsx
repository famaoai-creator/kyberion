'use client';

import * as React from 'react';
import { Badge, Button, Callout, Disclosure, Section } from '@agent/shared-ui';
import { localeToBcp47 } from '@agent/core/locale-normalize';
import { conciergeText, frontDeskText, type ConciergeLocale } from '../../lib/i18n';
import { cardSummary, kindBrief, renderDisplayText } from '../../lib/decision-brief-view';
import { deriveCardFields, type DecideQueueEntry } from '../../lib/decide-view';
import type { NeedsYouItem, NeedsYouReason } from '../../lib/needs-you-client';
import { BriefStateBadge, DecisionBriefBlock, KindBriefBlock } from '../decision-brief';
import { OutcomeFiles } from '../outcome-files';

/**
 * One card shape for every needs-you item (contract §2): who asks (an agent
 * is labelled as one), the related mission, the ask in one sentence, the
 * impact, the deadline, and only the actions the item lists. The card never
 * writes: each action is a callback the page wires to that kind's one
 * governed endpoint (`lib/needs-you-client.ts`).
 */

export type CardDecision =
  | { kind: 'approval'; item: NeedsYouItem; decision: 'approved' | 'rejected' }
  | {
      kind: 'review';
      item: NeedsYouItem;
      status: 'accepted' | 'changes_requested' | 'rejected';
      note?: string;
    }
  | { kind: 'knowledge'; item: NeedsYouItem; decision: 'approve' | 'reject' }
  | { kind: 'clarification'; item: NeedsYouItem; decision: 'start' | 'cancel'; note?: string };

export interface OutcomePreviewState {
  id: string | null;
  data: {
    files: Array<{
      name: string;
      kind: string;
      content?: string;
      data_uri?: string;
      missing?: boolean;
      too_large?: boolean;
      truncated?: boolean;
    }>;
    total: number;
    shown: number;
  } | null;
  error: string | null;
  busy: boolean;
  toggle(item: NonNullable<NeedsYouItem['outcome']>): void | Promise<void>;
}

type Tone = 'accent' | 'warning' | 'info' | 'success' | 'danger' | 'neutral';

/** Reason tag tone — label + tone, never color alone. Red is reserved for overdue. */
export const REASON_TONES: Record<NeedsYouReason, Tone> = {
  approval: 'accent',
  decision: 'info',
  review: 'success',
  knowledge: 'info',
  clarification: 'warning',
  failure: 'warning',
};

const RELATIVE_TIME_THRESHOLDS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
];

/** Browser-only relative time (the shared formatter pulls in node-only modules). */
export function relativeWhen(
  value: string | undefined,
  locale: ConciergeLocale
): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const diffMs = date.getTime() - Date.now();
  const formatter = new Intl.RelativeTimeFormat(localeToBcp47(locale), { numeric: 'auto' });
  for (const { unit, ms } of RELATIVE_TIME_THRESHOLDS) {
    if (Math.abs(diffMs) >= ms) return formatter.format(Math.round(diffMs / ms), unit);
  }
  return formatter.format(Math.round(diffMs / 1000), 'second');
}

export function formatWhen(value: string | undefined, locale: ConciergeLocale): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(localeToBcp47(locale), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The existing per-kind card-field mapping, reused through the old queue entry shape. */
function legacyEntry(item: NeedsYouItem): DecideQueueEntry | null {
  if (item.approval) return { id: item.id, kind: 'approval', item: item.approval as never };
  if (item.outcome) return { id: item.id, kind: 'outcome', item: item.outcome as never };
  if (item.knowledge) return { id: item.id, kind: 'memory', item: item.knowledge as never };
  if (item.clarification)
    return { id: item.id, kind: 'hygiene', item: item.clarification as never };
  if (item.failure) return { id: item.id, kind: 'exception', item: item.failure as never };
  return null;
}

/**
 * Where a `#<anchor>` deep link lands once the queue has loaded (review UX-L6):
 * the card itself, the lead card of the folded group that holds it, or — for a
 * card the viewer set aside — the card after revealing it (`reveal`).
 */
export function resolveInboxAnchor(
  items: readonly NeedsYouItem[],
  deferred: ReadonlySet<string>,
  hash: string
): { scrollTo: string; reveal?: string } | null {
  const target = hash.replace(/^#/u, '');
  if (!target) return null;
  for (const item of items) {
    const hit =
      cardAnchor(item) === target ||
      (item.group ?? []).some((other) => cardAnchor(other) === target);
    if (!hit) continue;
    return deferred.has(item.id)
      ? { scrollTo: cardAnchor(item), reveal: item.id }
      : { scrollTo: cardAnchor(item) };
  }
  return null;
}

/**
 * Where a deep link lands: the URL hash wins; otherwise `?request=<id>` (the
 * links mission admission and learning review emit, and the `/ops?section=
 * approvals&request=` redirect) targets that approval's card.
 */
export function inboxLandingHash(hash: string, search: string | URLSearchParams): string {
  if (hash && hash !== '#') return hash;
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const request = params.get('request')?.trim();
  return request ? `#decide-approval-${encodeURIComponent(request)}` : '';
}

/**
 * The card's anchor. Approvals keep the legacy `decide-approval-<id>` anchor
 * so existing deep links (`inboxHrefForApproval`) land on the card.
 */
export function cardAnchor(item: NeedsYouItem): string {
  return item.approval
    ? `decide-approval-${encodeURIComponent(item.approval.id)}`
    : `inbox-${item.id}`;
}

export function itemTitle(
  item: NeedsYouItem,
  locale: ConciergeLocale,
  t: (key: string) => string
): string {
  if (item.knowledge)
    return t(`memory.kind.${item.knowledge.kind}`) || renderDisplayText(item.title, locale);
  return renderDisplayText(item.title, locale);
}

/** The tenant's customer-decision card on 組織 (its open cases and agendas). */
export function customerDecisionCardHref(tenant?: string): string {
  const query = tenant ? `?${new URLSearchParams({ tenant }).toString()}` : '';
  return `/org${query}#customer-decisions`;
}

export function NeedsYouCard({
  item,
  locale,
  t,
  busy,
  isBusy,
  onDecide,
  onLater,
  preview,
  nested = false,
}: {
  item: NeedsYouItem;
  locale: ConciergeLocale;
  t: (key: string, params?: Record<string, string | number>) => string;
  busy: boolean;
  /** Per-card busy state, so each folded record is disabled by its own decision. */
  isBusy?: (id: string) => boolean;
  onDecide(decision: CardDecision): void | Promise<void>;
  onLater?(item: NeedsYouItem): void;
  preview: OutcomePreviewState;
  nested?: boolean;
}) {
  const c = (key: string, params?: Record<string, string | number>) =>
    conciergeText(key as Parameters<typeof conciergeText>[0], locale, params);
  const f = (key: string, params?: Record<string, string | number>) =>
    frontDeskText(key as Parameters<typeof frontDeskText>[0], locale, params);
  const [confirm, setConfirm] = React.useState<null | 'yes' | 'no'>(null);
  const [note, setNote] = React.useState('');
  const [changeForm, setChangeForm] = React.useState(false);

  const entry = legacyEntry(item);
  const fields = entry ? deriveCardFields(entry) : {};
  const whyRaw = item.clarification && fields.why ? t(`hygiene.reason.${fields.why}`) : fields.why;
  const why = whyRaw ? cardSummary(whyRaw) : null;
  const has = (action: NeedsYouItem['actions'][number]) => item.actions.includes(action);
  const relative = relativeWhen(item.waiting_since, locale);
  const requester = renderDisplayText(item.requester.label, locale);
  const brief = item.approval?.brief;

  const later =
    has('later') && onLater && !nested ? (
      <Button
        label={f('decide_later')}
        variant="ghost"
        disabled={busy}
        onClick={() => onLater(item)}
      />
    ) : null;

  let body: React.ReactNode = null;
  let actions: React.ReactNode = null;

  if (item.approval) {
    const approval = item.approval;
    const approveLabel =
      approval.min_assurance === 'A3' ? f('decide_approve_passkey') : f('decide_approve');
    body = (
      <>
        {brief ? (
          <DecisionBriefBlock
            brief={brief}
            locale={locale}
            showAsk={false}
            approveLabel={approveLabel}
            rejectLabel={f('decide_reject')}
          />
        ) : null}
        {approval.review_scope || approval.evidence?.length ? (
          <details className="approval-review-scope">
            <summary>{t('queue.review_scope')}</summary>
            {approval.evidence?.map((evidence) => (
              <p key={`${evidence.label}:${evidence.ref}`}>
                {evidence.label}
                <br />
                <code>{evidence.ref}</code>
              </p>
            ))}
            {approval.review_scope ? (
              <pre className="inbox-review-scope">{approval.review_scope}</pre>
            ) : null}
          </details>
        ) : null}
      </>
    );
    actions = (
      <>
        {has('approve') ? (
          <Button
            label={approveLabel}
            variant="primary"
            disabled={busy}
            onClick={() => void onDecide({ kind: 'approval', item, decision: 'approved' })}
          />
        ) : null}
        {has('reject') ? (
          <Button
            label={f('decide_reject')}
            variant="danger"
            disabled={busy}
            onClick={() => void onDecide({ kind: 'approval', item, decision: 'rejected' })}
          />
        ) : null}
        {later}
      </>
    );
  } else if (item.reason === 'decision') {
    body = (
      <div className="brief">
        <div className="brief-block">
          <p className="brief-label">{c('ux_a_brief_ask')}</p>
          <p className="brief-ask">{c('ia_inbox_decision_ask')}</p>
        </div>
      </div>
    );
    actions = (
      <>
        {has('mark_handled') ? (
          <Button
            label={c('ia_inbox_decision_mark_handled')}
            variant="primary"
            disabled={busy}
            onClick={() => void onDecide({ kind: 'review', item, status: 'accepted' })}
          />
        ) : null}
        {has('open') ? (
          <Button
            variant="secondary"
            href={customerDecisionCardHref(item.tenant_slug)}
            label={c('ia_inbox_decision_open')}
          />
        ) : null}
        {later}
      </>
    );
  } else if (item.outcome) {
    const outcome = item.outcome;
    const previewOpen = preview.id === outcome.entry_id;
    body = <KindBriefBlock brief={kindBrief('outcome')} locale={locale} />;
    actions = (
      <>
        {has('approve') ? (
          <Button
            label={f('decide_receive')}
            variant="primary"
            disabled={busy}
            onClick={() => void onDecide({ kind: 'review', item, status: 'accepted' })}
          />
        ) : null}
        {has('request_changes') ? (
          <Button
            label={f('decide_return')}
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setChangeForm(!changeForm);
              setNote('');
            }}
          />
        ) : null}
        {has('reject') ? (
          <Button
            label={f('decide_reject')}
            variant="danger"
            disabled={busy}
            onClick={() => void onDecide({ kind: 'review', item, status: 'rejected' })}
          />
        ) : null}
        {has('open') ? (
          <Button
            label={previewOpen ? t('home.preview_hide') : f('action_open')}
            variant="secondary"
            onClick={() => void preview.toggle(outcome)}
          />
        ) : null}
        {later}
      </>
    );
  } else if (item.knowledge) {
    body = <KindBriefBlock brief={kindBrief('memory')} locale={locale} />;
    actions = item.knowledge.learningReviewUrl ? (
      <>
        <Button
          variant="primary"
          href={item.knowledge.learningReviewUrl}
          label={t('memory.review_in_library')}
        />
        {later}
      </>
    ) : (
      <>
        <Button
          label={f('decide_remember')}
          variant="primary"
          disabled={busy}
          onClick={() => setConfirm('yes')}
        />
        <Button
          label={f('decide_forget')}
          variant="danger"
          disabled={busy}
          onClick={() => setConfirm('no')}
        />
        {later}
      </>
    );
  } else if (item.clarification) {
    body = <KindBriefBlock brief={kindBrief('hygiene')} locale={locale} />;
    actions = (
      <>
        <Button
          label={f('decide_continue')}
          variant="primary"
          disabled={busy}
          onClick={() => {
            setConfirm('yes');
            setNote('');
          }}
        />
        <Button
          label={f('decide_stop')}
          variant="danger"
          disabled={busy}
          onClick={() => {
            setConfirm('no');
            setNote('');
          }}
        />
        {later}
      </>
    );
  } else {
    body = <KindBriefBlock brief={kindBrief('exception')} locale={locale} />;
    actions = later;
  }

  // Knowledge and stalled-request decisions go through one inline confirm step.
  const confirmBlock =
    confirm && (item.knowledge || item.clarification) ? (
      <div className="decide-confirm">
        <p className="decide-confirm-text">
          {item.knowledge
            ? t(confirm === 'yes' ? 'memory.confirm_approve' : 'memory.confirm_reject')
            : t(confirm === 'yes' ? 'hygiene.confirm_start' : 'hygiene.confirm_cancel')}
        </p>
        {item.clarification && confirm === 'no' ? (
          <label className="kb-field">
            <span className="kb-field__label">{t('hygiene.note_label')}</span>
            <textarea
              className="kb-input kb-textarea"
              value={note}
              rows={2}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
        ) : null}
        <div className="decide-actions">
          <Button
            label={t(item.knowledge ? 'memory.confirm_yes' : 'hygiene.confirm_yes')}
            variant={confirm === 'no' ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() =>
              void onDecide(
                item.knowledge
                  ? { kind: 'knowledge', item, decision: confirm === 'yes' ? 'approve' : 'reject' }
                  : {
                      kind: 'clarification',
                      item,
                      decision: confirm === 'yes' ? 'start' : 'cancel',
                      note,
                    }
              )
            }
          />
          <Button
            label={t(item.knowledge ? 'memory.confirm_back' : 'hygiene.confirm_back')}
            variant="secondary"
            disabled={busy}
            onClick={() => setConfirm(null)}
          />
        </div>
      </div>
    ) : null;

  const outcome = item.outcome;
  return (
    <div
      id={cardAnchor(item)}
      tabIndex={-1}
      className="decide-card inbox-card"
      data-reason={item.reason}
    >
      <Section title={itemTitle(item, locale, t)} headingLevel={3}>
        <div className="decide-card-meta">
          <Badge label={c(`ia_inbox_reason_${item.reason}`)} tone={REASON_TONES[item.reason]} />
          {item.overdue ? (
            <Badge
              label={c(
                item.deadline && Date.parse(item.deadline) < Date.now()
                  ? 'ia_inbox_overdue_badge'
                  : 'ia_inbox_waiting_long_badge'
              )}
              tone="danger"
            />
          ) : null}
          {item.group_size > 1 ? (
            <Badge label={c('ux_a_brief_same_count', { count: item.group_size })} tone="neutral" />
          ) : null}
          {item.requester.agent ? <Badge label={c('ia_inbox_agent_badge')} tone="neutral" /> : null}
          {item.knowledge ? (
            // Plain-language tier label; the internal tier code never renders.
            <Badge label={t(`memory.tier.${item.knowledge.sensitivity_tier}`)} tone="neutral" />
          ) : null}
          <span className="decide-by-badge">{c('ia_inbox_asked_by', { name: requester })}</span>
          {item.tenant_slug ? <Badge label={item.tenant_slug} tone="info" /> : null}
          <BriefStateBadge brief={brief} locale={locale} />
          {relative ? (
            <span
              className="decide-time"
              title={formatWhen(item.waiting_since, locale) || undefined}
            >
              {relative}
            </span>
          ) : null}
          {item.deadline ? (
            <span className="decide-time decide-due">
              {f('decide_due', {
                value: relativeWhen(item.deadline, locale) || formatWhen(item.deadline, locale),
              })}
            </span>
          ) : null}
        </div>
        {body}
        {why?.short ? (
          <div className="decide-columns">
            <div className="decide-column">
              <p className="decide-column-label">{f('decide_why')}</p>
              <p className="decide-column-body">{why.short}</p>
              {why.clamped ? (
                <Disclosure summary={c('ux_a_show_more')}>
                  <p className="decide-column-body">{why.full}</p>
                </Disclosure>
              ) : null}
            </div>
          </div>
        ) : null}
        {confirmBlock ?? <div className="decide-actions">{actions}</div>}
        {item.mission_id && item.reason !== 'clarification' ? (
          <a
            className="decide-evidence-link"
            href={`/w/mission/${encodeURIComponent(item.mission_id)}`}
          >
            {c('ia_inbox_open_mission')}
          </a>
        ) : null}
        {outcome && outcome.artifact_paths.length > 0 ? (
          <OutcomeFiles entryId={outcome.entry_id} revision={outcome.updated_at} />
        ) : null}
        {outcome && preview.id === outcome.entry_id ? (
          <div
            className="outcome-preview"
            role="region"
            aria-label={outcome.title}
            aria-live="polite"
            aria-busy={preview.busy}
          >
            {preview.busy ? <p className="decide-muted">{t('home.loading')}</p> : null}
            {preview.error ? (
              <Callout tone="danger" title={t('home.preview_error', { error: preview.error })} />
            ) : null}
            {preview.data && preview.data.files.length === 0 ? (
              <p className="decide-muted">{t('home.preview_empty')}</p>
            ) : null}
            {preview.data?.files.map((file, index) => (
              <div className="preview-file" key={`${file.name}-${index}`}>
                <p className="preview-name">{file.name}</p>
                {file.kind === 'image' && file.data_uri ? (
                  <img className="preview-image" src={file.data_uri} alt={file.name} />
                ) : (file.kind === 'markdown' || file.kind === 'text') &&
                  typeof file.content === 'string' ? (
                  <pre className="preview-content">{file.content}</pre>
                ) : (
                  <p className="decide-muted">
                    {t(
                      file.missing
                        ? 'home.preview_missing'
                        : file.too_large
                          ? 'home.preview_too_large'
                          : 'home.preview_unsupported'
                    )}
                  </p>
                )}
                {file.truncated ? (
                  <p className="decide-muted">{t('home.preview_truncated')}</p>
                ) : null}
              </div>
            ))}
            {preview.data && preview.data.total > preview.data.shown ? (
              <p className="decide-muted">
                {t('home.preview_more', { count: preview.data.total - preview.data.shown })}
              </p>
            ) : null}
          </div>
        ) : null}
        {changeForm && outcome ? (
          <form
            className="decide-confirm"
            onSubmit={(event) => {
              event.preventDefault();
              void onDecide({ kind: 'review', item, status: 'changes_requested', note });
            }}
          >
            <label className="kb-field">
              <span className="kb-field__label">{t('home.change_prompt')}</span>
              <textarea
                className="kb-input kb-textarea"
                value={note}
                rows={3}
                required
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <div className="decide-actions">
              <Button
                type="submit"
                label={t('home.change_send')}
                variant="primary"
                disabled={busy || !note.trim()}
              />
              <Button
                label={t('home.change_cancel')}
                variant="secondary"
                onClick={() => {
                  setChangeForm(false);
                  setNote('');
                }}
              />
            </div>
          </form>
        ) : null}
        {!nested && item.group?.length ? (
          <Disclosure summary={c('ia_inbox_group_expand', { count: item.group_size })}>
            <p className="decide-muted">{c('ux_a_brief_same_lead')}</p>
            <div className="decide-list brief-group">
              {item.group.map((other) => (
                <NeedsYouCard
                  key={other.id}
                  item={other}
                  locale={locale}
                  t={t}
                  busy={isBusy ? isBusy(other.id) : busy}
                  isBusy={isBusy}
                  onDecide={onDecide}
                  preview={preview}
                  nested
                />
              ))}
            </div>
          </Disclosure>
        ) : null}
      </Section>
    </div>
  );
}
