/**
 * Customer-room page. Reads the invite token from the URL fragment, removes
 * it from the address bar, then runs view -> answer -> confirm -> submit
 * against this process's own two API routes. All copy comes from the
 * `customer_room` vocabulary domain (embedded by the server, en + ja).
 */
import { fetchAttachment, respond, viewAgenda, type ApiResult, type FetchFn } from './api.js';
import {
  buildAnswers,
  commentRequired,
  describeDraft,
  describeValue,
  emptyDraft,
  entryAttachments,
  entryLinks,
  formatRespondBy,
  formatSize,
  GENERAL_QUESTION_MAX,
  isPendingCustomer,
  isRespondByPast,
  localCalendarDate,
  normalizeGeneralQuestion,
  issueMessageKey,
  keepAvailable,
  needsOurConfirmation,
  parseFragmentToken,
  pickLocale,
  screenForReason,
  sourceKey,
  type AnswerPayload,
  type Draft,
  type DraftIssue,
  type RoomLocale,
  type ScreenState,
  type ViewEntry,
  type ViewOpen,
  type ViewAttachment,
  type ViewReceipt,
} from './model.js';

type Bundle = Record<string, string>;
type Vocabulary = Record<RoomLocale, Bundle>;

function readVocabulary(): Vocabulary {
  const node = document.getElementById('cr-vocabulary');
  try {
    const parsed = JSON.parse(node?.textContent ?? '{}') as Partial<Vocabulary>;
    return { en: parsed.en ?? {}, ja: parsed.ja ?? {} };
  } catch {
    return { en: {}, ja: {} };
  }
}

const vocabulary = readVocabulary();
let locale: RoomLocale = pickLocale(undefined, navigator.languages ?? [navigator.language]);

function t(key: string, params: Record<string, string | number> = {}): string {
  // Never show a raw key: fall back to English, then to nothing.
  const template = vocabulary[locale][key] ?? vocabulary.en[key] ?? '';
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) =>
    name in params ? String(params[name]) : `{${name}}`
  );
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setLocale(next: RoomLocale): void {
  locale = next;
  document.documentElement.lang = next;
  document.title = t('page_title');
}

const root = document.getElementById('cr-root') as HTMLElement;
const token = parseFragmentToken(window.location.hash);
// The token never stays in the address bar, history entry or a later copy of the URL.
if (window.location.hash) {
  window.history.replaceState(null, '', `${window.location.pathname}`);
}

const fetchFn: FetchFn = (input, init) => fetch(input, init);

function clear(): void {
  root.replaceChildren();
}

// ---------------------------------------------------------------------------
// Images: fetched with the token header, shown from blob: URLs
// ---------------------------------------------------------------------------

/** One object URL per image for the open form; null = could not be shown. */
const imageUrls = new Map<string, Promise<string | null>>();
let imageObserver: IntersectionObserver | null = null;

/** Revoke every image URL (leaving the form, reloading, leaving the page). */
function releaseImages(): void {
  imageObserver?.disconnect();
  imageObserver = null;
  const pending = [...imageUrls.values()];
  imageUrls.clear();
  for (const url of pending) {
    void url.then((value) => {
      if (value) URL.revokeObjectURL(value);
    });
  }
}

function imageUrl(attachment: ViewAttachment): Promise<string | null> {
  const known = imageUrls.get(attachment.id);
  if (known) return known;
  const created =
    heldToken === null
      ? Promise.resolve(null)
      : fetchAttachment(fetchFn, heldToken, attachment.id).then((blob) =>
          blob ? URL.createObjectURL(blob) : null
        );
  imageUrls.set(attachment.id, created);
  return created;
}

function showImage(frame: HTMLElement, attachment: ViewAttachment): void {
  const urls = imageUrls;
  void imageUrl(attachment).then((url) => {
    // The form was left meanwhile: nothing to show, the URL is already revoked.
    if (urls !== imageUrls || !frame.isConnected) return;
    if (!url) {
      frame.replaceChildren(el('p', 'kb-text kb-text--muted', t('attachment_failed')));
      frame.dataset.state = 'failed';
      return;
    }
    const img = el('img', 'cr-attachment__image');
    // The caption already names the image; a file name is not a useful description.
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('error', () => {
      frame.replaceChildren(el('p', 'kb-text kb-text--muted', t('attachment_failed')));
      frame.dataset.state = 'failed';
    });
    img.src = url;
    frame.replaceChildren(img);
    frame.dataset.state = 'shown';
  });
}

/** Fetch an image when its frame comes near the screen (all at once without IntersectionObserver). */
function loadWhenVisible(frame: HTMLElement, attachment: ViewAttachment): void {
  if (typeof IntersectionObserver === 'undefined') {
    showImage(frame, attachment);
    return;
  }
  imageObserver ??= new IntersectionObserver(
    (seen, observer) => {
      for (const item of seen) {
        if (!item.isIntersecting) continue;
        observer.unobserve(item.target);
        const target = item.target as HTMLElement;
        const found = session?.view.entries
          .flatMap((entry) => entryAttachments(entry))
          .find((candidate) => candidate.id === target.dataset.attachment);
        if (found) showImage(target, found);
      }
    },
    { rootMargin: '200px 0px' }
  );
  imageObserver.observe(frame);
}

function attachmentsBlock(entry: ViewEntry): HTMLElement | null {
  const attachments = entryAttachments(entry);
  if (attachments.length === 0) return null;
  const block = el('div', 'kb-stack cr-attachments');
  block.dataset.gap = 'sm';
  block.append(el('p', 'kb-text kb-text--caption', t('attachments_heading')));
  for (const attachment of attachments) {
    const figure = el('figure', 'cr-attachment');
    const frame = el('div', 'cr-attachment__frame');
    frame.dataset.attachment = attachment.id;
    frame.dataset.state = 'loading';
    const waiting = el('p', 'kb-text kb-text--muted', t('attachment_loading'));
    frame.append(waiting);
    figure.append(
      frame,
      el(
        'figcaption',
        'kb-text kb-text--caption',
        t('attachment_caption', {
          name: attachment.name,
          size: formatSize(attachment.bytes, locale),
        })
      )
    );
    block.append(figure);
    loadWhenVisible(frame, attachment);
  }
  return block;
}

function linksBlock(entry: ViewEntry): HTMLElement | null {
  const links = entryLinks(entry);
  if (links.length === 0) return null;
  const block = el('div', 'cr-links');
  block.append(el('p', 'kb-text kb-text--caption', t('links_heading')));
  const list = el('ul', 'kb-list');
  for (const link of links) {
    const item = el('li', 'kb-list__item');
    const body = el('div', 'kb-list__body');
    const anchor = el('a', 'kb-list__title cr-link', link.label);
    anchor.href = link.href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.referrerPolicy = 'no-referrer';
    body.append(anchor, el('p', 'kb-list__meta', t('link_host', { host: link.host })));
    item.append(body);
    list.append(item);
  }
  block.append(list);
  return block;
}

/** After a screen change: the new heading takes focus and the page starts at the top. */
function focusHeading(): void {
  const heading = root.querySelector('h1');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Plain states
// ---------------------------------------------------------------------------

const STATE_KEYS: Record<ScreenState, { title: string; body: string; tone: string }> = {
  updating: { title: 'state_updating_title', body: 'state_updating_body', tone: 'info' },
  closed: { title: 'state_closed_title', body: 'state_closed_body', tone: 'info' },
  expired: { title: 'state_expired_title', body: 'state_expired_body', tone: 'warning' },
  revoked: { title: 'state_revoked_title', body: 'state_revoked_body', tone: 'warning' },
  invalid_link: {
    title: 'state_invalid_link_title',
    body: 'state_invalid_link_body',
    tone: 'warning',
  },
  not_entitled: {
    title: 'state_not_entitled_title',
    body: 'state_not_entitled_body',
    tone: 'warning',
  },
  stale: { title: 'state_stale_title', body: 'state_stale_body', tone: 'info' },
  unavailable: {
    title: 'state_unavailable_title',
    body: 'state_unavailable_body',
    tone: 'danger',
  },
};

function showState(state: ScreenState): void {
  releaseImages();
  clear();
  const keys = STATE_KEYS[state];
  const card = el('section', 'kb-callout cr-state');
  card.dataset.tone = keys.tone;
  card.setAttribute('role', state === 'unavailable' ? 'alert' : 'status');
  card.append(el('h1', 'kb-callout__title', t(keys.title)), el('p', 'kb-text', t(keys.body)));
  if (state === 'stale' || state === 'unavailable') {
    const actionKey: 'reload' | 'retry_action' = state === 'stale' ? 'reload' : 'retry_action';
    const button = el('button', 'kb-btn kb-btn--primary', t(actionKey));
    button.type = 'button';
    button.addEventListener('click', () => {
      void start();
    });
    card.append(button);
  }
  root.append(card);
  focusHeading();
}

function showLoading(): void {
  clear();
  const status = el('p', 'kb-text kb-text--muted cr-loading', t('loading'));
  status.setAttribute('role', 'status');
  root.append(status);
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

interface Session {
  view: ViewOpen;
  drafts: Map<string, Draft>;
  /** Inline problems found when the person tried to review. */
  issues: Map<string, DraftIssue>;
  /** Set on submit: some answer needs our team's confirmation. */
  pendingConfirmation?: boolean;
  /** The "anything else you'd like to ask" text as typed. */
  generalQuestion: string;
  /** Inline problem with the question, found when the person tried to review. */
  generalIssue?: 'general_too_long';
  /** The question that was sent, for the thank-you screen. */
  sentQuestion?: string;
}

let session: Session | null = null;

function draftFor(entryId: string): Draft {
  const existing = session?.drafts.get(entryId);
  if (existing) return existing;
  const created = emptyDraft();
  session?.drafts.set(entryId, created);
  return created;
}

function impactBlock(option: ViewEntry['options'][number]): HTMLElement | null {
  if (!option.impact) return null;
  const list = el('dl', 'kb-kv cr-impact');
  const rows: Array<[string, string | undefined]> = [
    ['impact_cost', option.impact.cost],
    ['impact_schedule', option.impact.schedule],
    ['impact_scope', option.impact.scope],
    ['impact_rework', option.impact.rework],
  ];
  for (const [key, value] of rows) {
    if (!value) continue;
    const row = el('div', 'cr-impact__row');
    row.append(el('dt', 'kb-kv__label', t(key)), el('dd', 'kb-kv__value', value));
    list.append(row);
  }
  return list.childElementCount > 0 ? list : null;
}

function currentLine(entry: ViewEntry): string {
  const wording = describeValue(entry, entry.current.value);
  const source = t(sourceKey(entry.current));
  const line = isPendingCustomer(entry.current) ? 'current_line_pending' : 'current_line';
  switch (wording.kind) {
    case 'text':
      return t(line, { value: wording.text, source });
    case 'approved':
      return t(line, { value: t('value_approved'), source });
    case 'changes_requested':
      return t(line, { value: t('value_changes_requested'), source });
    case 'rejected':
      return t(line, { value: t('value_rejected'), source });
    default:
      return entry.requires_customer ? t('source_awaiting') : t('current_none');
  }
}

function draftBlock(entry: ViewEntry): HTMLElement | null {
  const view = describeDraft(entry.draft);
  if (view.kind === 'none') return null;
  const box = el('div', 'kb-callout cr-draft');
  box.dataset.tone = 'neutral';
  box.append(el('p', 'kb-text kb-text--caption', t('draft_heading')));
  if (view.kind === 'accept') {
    box.append(el('p', 'kb-text', t('draft_accept')));
  } else if (view.kind === 'text') {
    box.append(el('p', 'kb-text', view.text));
  } else if (view.kind === 'list') {
    const list = el('ul', 'cr-draft__list');
    for (const item of view.items) list.append(el('li', 'kb-text', item));
    box.append(list);
  } else {
    const list = el('dl', 'kb-kv cr-impact');
    for (const [label, value] of view.pairs) {
      const row = el('div', 'cr-impact__row');
      row.append(el('dt', 'kb-kv__label', label), el('dd', 'kb-kv__value', value));
      list.append(row);
    }
    box.append(list);
  }
  return box;
}

function radio(
  name: string,
  label: string,
  checked: boolean,
  onSelect: () => void,
  extra?: HTMLElement | null
): HTMLElement {
  const wrap = el('label', 'kb-check cr-choice');
  const input = el('input', 'kb-check__input');
  input.type = 'radio';
  input.name = name;
  input.checked = checked;
  input.addEventListener('change', onSelect);
  const text = el('span', 'kb-check__text');
  text.append(el('span', 'kb-check__label', label));
  if (extra) text.append(extra);
  wrap.append(input, text);
  return wrap;
}

function renderEntry(entry: ViewEntry, index: number, total: number): HTMLElement {
  const draft = draftFor(entry.entry_id);
  const card = el('section', 'kb-section cr-entry');
  card.dataset.entry = entry.entry_id;
  if (entry.requires_customer) card.dataset.tone = 'accent';
  const rerender = (): void => {
    session?.issues.delete(entry.entry_id);
    const next = renderEntry(entry, index, total);
    card.replaceWith(next);
    updateProgress();
  };

  const head = el('div', 'cr-entry__head');
  head.append(
    el('span', 'kb-text kb-text--caption', t('item_position', { index: index + 1, total }))
  );
  if (entry.requires_customer) {
    const badge = el('span', 'kb-badge', t('needs_decision'));
    badge.dataset.tone = 'accent';
    head.append(badge);
  }
  card.append(head, el('h2', 'kb-section__title', entry.question));
  if (entry.background)
    card.append(el('p', 'kb-text kb-text--muted cr-background', entry.background));
  const images = attachmentsBlock(entry);
  if (images) card.append(images);
  const links = linksBlock(entry);
  if (links) card.append(links);

  const current = el('div', 'kb-callout cr-current');
  current.dataset.tone = 'info';
  current.append(
    el('p', 'kb-text kb-text--caption', t('current_heading')),
    el('p', 'kb-text', currentLine(entry))
  );
  card.append(current);

  const name = `choice-${entry.entry_id}`;
  const issue = session?.issues.get(entry.entry_id);
  const group = el('fieldset', 'kb-choice-group cr-group');
  group.append(el('legend', 'cr-sr-only', entry.question));
  const options = el('div', 'kb-choice-group__options');
  group.append(options);

  if (entry.kind === 'choice') {
    entry.options.forEach((option, optionIndex) => {
      options.append(
        radio(
          name,
          option.label,
          draft.choice === 'option' && draft.optionIndex === optionIndex,
          () => {
            draft.choice = 'option';
            draft.optionIndex = optionIndex;
            rerender();
          },
          impactBlock(option)
        )
      );
    });
  } else if (entry.kind === 'approval') {
    const draftNode = draftBlock(entry);
    if (draftNode) card.append(draftNode);
    options.append(
      radio(name, t('approve'), draft.choice === 'approve', () => {
        draft.choice = 'approve';
        rerender();
      }),
      radio(name, t('request_changes'), draft.choice === 'request_changes', () => {
        draft.choice = 'request_changes';
        rerender();
      }),
      radio(name, t('reject'), draft.choice === 'reject', () => {
        draft.choice = 'reject';
        rerender();
      })
    );
  } else if (entry.kind === 'ranking') {
    group.insertBefore(el('p', 'kb-text kb-text--caption', t('ranking_hint')), options);
    entry.options.forEach((option, optionIndex) => {
      const position = draft.ranking.indexOf(optionIndex);
      const wrap = el('label', 'kb-check cr-choice');
      const input = el('input', 'kb-check__input');
      input.type = 'checkbox';
      input.checked = position >= 0;
      input.addEventListener('change', () => {
        draft.choice = undefined;
        draft.ranking =
          position >= 0
            ? draft.ranking.filter((item) => item !== optionIndex)
            : [...draft.ranking, optionIndex];
        rerender();
      });
      const text = el('span', 'kb-check__text');
      text.append(el('span', 'kb-check__label', option.label));
      if (position >= 0) {
        const mark = el('span', 'kb-badge', t('ranking_position', { position: position + 1 }));
        mark.dataset.tone = 'accent';
        text.append(mark);
      }
      const impact = impactBlock(option);
      if (impact) text.append(impact);
      wrap.append(input, text);
      options.append(wrap);
    });
  } else {
    const field = el('label', 'kb-field');
    field.append(el('span', 'kb-field__label', t('hearing_label')));
    const area = el('textarea', 'kb-input kb-textarea');
    area.rows = 4;
    area.value = draft.text;
    area.maxLength = 4000;
    area.addEventListener('input', () => {
      draft.text = area.value;
      if (area.value.trim()) draft.choice = undefined;
      updateProgress();
    });
    field.append(area);
    card.append(field);
  }

  if (keepAvailable(entry) && entry.kind !== 'approval') {
    options.append(
      radio(name, t('choice_keep'), draft.choice === 'keep', () => {
        draft.choice = 'keep';
        draft.ranking = [];
        rerender();
      })
    );
  }
  if (entry.kind !== 'hearing') {
    if (issue === 'selection_invalid') {
      const problem = el('p', 'kb-field__help cr-field-error', t('selection_invalid'));
      problem.id = `err-${entry.entry_id}`;
      group.setAttribute('aria-invalid', 'true');
      group.setAttribute('aria-describedby', problem.id);
      group.append(problem);
    }
    card.append(group);
  }

  const needsComment = commentRequired(draft.choice);
  const commentField = el('label', 'kb-field');
  commentField.append(
    el(
      'span',
      'kb-field__label',
      t(needsComment ? 'comment_required_label' : 'answer_comment_label')
    )
  );
  const comment = el('textarea', 'kb-input kb-textarea');
  comment.rows = 2;
  comment.maxLength = 2000;
  comment.value = draft.comment;
  comment.placeholder = t('comment_placeholder');
  comment.addEventListener('input', () => {
    draft.comment = comment.value;
    if (session?.issues.delete(entry.entry_id)) {
      comment.removeAttribute('aria-invalid');
      if (needsComment) comment.setAttribute('aria-describedby', `hint-${entry.entry_id}`);
      else comment.removeAttribute('aria-describedby');
      commentField.querySelector('.cr-field-error')?.remove();
    }
    updateProgress();
  });
  commentField.append(comment);
  if (needsComment) {
    const hint = el(
      'span',
      'kb-field__help',
      t(draft.choice === 'reject' ? 'reject_hint' : 'request_changes_hint')
    );
    hint.id = `hint-${entry.entry_id}`;
    commentField.append(hint);
    comment.setAttribute('aria-describedby', hint.id);
  }
  if (issue === 'comment_required' || issue === 'reason_required') {
    const problem = el('span', 'kb-field__help cr-field-error', t(issueMessageKey(issue)));
    problem.id = `err-${entry.entry_id}`;
    problem.setAttribute('role', 'alert');
    comment.setAttribute('aria-invalid', 'true');
    comment.setAttribute(
      'aria-describedby',
      [comment.getAttribute('aria-describedby'), problem.id].filter(Boolean).join(' ')
    );
    commentField.append(problem);
  }
  card.append(commentField);
  return card;
}

let progressNode: HTMLElement | null = null;
let reviewButton: HTMLButtonElement | null = null;
let reviewHint: HTMLElement | null = null;

function updateProgress(): void {
  if (!session || !progressNode) return;
  const total = session.view.entries.length;
  const built = buildAnswers(session.view.entries, session.drafts);
  const answered = built.answers.length;
  const remaining = total - answered;
  progressNode.textContent =
    remaining > 0 ? t('remaining', { count: remaining }) : t('remaining_done');
  // An incomplete answer (e.g. reject without a reason) keeps the button usable:
  // pressing it shows what is missing next to the item. A question alone is enough too.
  const reviewable =
    answered > 0 || built.issues.length > 0 || session.generalQuestion.trim().length > 0;
  if (reviewButton) reviewButton.disabled = !reviewable;
  if (reviewHint) reviewHint.hidden = reviewable;
}

/** The optional, agenda-wide question at the end of the form. */
function generalQuestionBlock(): HTMLElement {
  const card = el('section', 'kb-section cr-general');
  card.append(el('h2', 'kb-section__title', t('general_heading')));
  const field = el('label', 'kb-field');
  const hint = el('span', 'kb-field__help', t('general_hint'));
  hint.id = 'general-hint';
  const area = el('textarea', 'kb-input kb-textarea');
  area.id = 'general-question';
  area.rows = 3;
  area.maxLength = GENERAL_QUESTION_MAX;
  area.value = session?.generalQuestion ?? '';
  area.setAttribute('aria-label', t('general_heading'));
  area.setAttribute('aria-describedby', hint.id);
  const problem = el(
    'span',
    'kb-field__help cr-field-error',
    t('general_too_long', { max: GENERAL_QUESTION_MAX })
  );
  problem.id = 'general-error';
  problem.setAttribute('role', 'alert');
  const showIssue = (shown: boolean): void => {
    problem.hidden = !shown;
    if (shown) {
      area.setAttribute('aria-invalid', 'true');
      area.setAttribute('aria-describedby', `${hint.id} ${problem.id}`);
    } else {
      area.removeAttribute('aria-invalid');
      area.setAttribute('aria-describedby', hint.id);
    }
  };
  showIssue(session?.generalIssue !== undefined);
  area.addEventListener('input', () => {
    if (!session) return;
    session.generalQuestion = area.value;
    if (session.generalIssue && !('issue' in normalizeGeneralQuestion(area.value))) {
      session.generalIssue = undefined;
      showIssue(false);
    }
    updateProgress();
  });
  field.append(hint, area, problem);
  card.append(field);
  return card;
}

function showForm(): void {
  if (!session) return;
  const { view } = session;
  clear();
  const header = el('header', 'kb-page-header cr-header');
  const titles = el('div', 'kb-page-header__titles');
  titles.append(el('h1', 'kb-page-header__title', view.agenda.title));
  if (view.agenda.from) {
    titles.append(el('p', 'kb-page-header__subtitle', t('from_line', { from: view.agenda.from })));
  }
  titles.append(
    el('p', 'kb-page-header__subtitle', t('participant_line', { name: view.participant.name }))
  );
  const target = formatRespondBy(view.agenda.respond_by, locale, new Date().getFullYear());
  if (target) {
    // A calendar date, shown in neutral wording; answers stay open after it.
    const past = isRespondByPast(view.agenda.respond_by, localCalendarDate(new Date()));
    titles.append(
      el(
        'p',
        'kb-page-header__subtitle cr-respond-by',
        t(past ? 'respond_by_past' : 'respond_by_line', { date: target })
      )
    );
  }
  header.append(titles);
  root.append(header);

  const role = el('div', 'kb-callout', undefined);
  role.dataset.tone = 'info';
  role.append(
    el('p', 'kb-text', t(view.participant.role === 'decider' ? 'role_decider' : 'role_contributor'))
  );
  root.append(role);

  const last = latestReceipt(view.receipts);
  if (last) {
    const note = el(
      'p',
      'kb-text kb-text--muted',
      t(
        view.participant.role === 'decider'
          ? 'previous_submission'
          : 'previous_submission_contributor',
        { date: formatDate(last.submitted_at) }
      )
    );
    root.append(note);
    if (last.general_question) {
      root.append(
        el('p', 'kb-text kb-text--muted', t('previous_question', { text: last.general_question }))
      );
    }
  }

  progressNode = el('p', 'kb-status-pill cr-progress');
  progressNode.setAttribute('role', 'status');
  progressNode.setAttribute('aria-live', 'polite');
  root.append(progressNode);

  const list = el('div', 'kb-stack cr-entries');
  list.dataset.gap = 'md';
  view.entries.forEach((entry, index) => {
    list.append(renderEntry(entry, index, view.entries.length));
  });
  root.append(list, generalQuestionBlock());

  const bar = el('div', 'cr-actions');
  reviewButton = el('button', 'kb-btn kb-btn--primary', t('review_button'));
  reviewButton.type = 'button';
  reviewButton.addEventListener('click', showReview);
  reviewHint = el('p', 'kb-text kb-text--caption', t('review_disabled_hint'));
  reviewHint.id = 'review-hint';
  reviewButton.setAttribute('aria-describedby', reviewHint.id);
  bar.append(reviewButton, reviewHint);
  root.append(bar);
  updateProgress();
  focusHeading();
}

function latestReceipt(receipts: readonly ViewReceipt[]): ViewReceipt | undefined {
  return receipts.length > 0 ? receipts[receipts.length - 1] : undefined;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

// ---------------------------------------------------------------------------
// Confirm + receipt
// ---------------------------------------------------------------------------

function answerSummary(entry: ViewEntry, answer: AnswerPayload): string {
  switch (answer.choice) {
    case 'keep': {
      const wording = describeValue(entry, entry.current.value);
      return wording.kind === 'text'
        ? t('choice_keep_with', { value: wording.text })
        : t('choice_keep');
    }
    case 'approve':
      return t('approve');
    case 'request_changes':
      return t('request_changes');
    case 'reject':
      return t('reject');
    case 'option': {
      const wording = describeValue(entry, answer.value);
      return wording.kind === 'text' ? wording.text : '';
    }
    default:
      return typeof answer.value === 'string' ? answer.value : '';
  }
}

function showReview(): void {
  if (!session) return;
  const { view, drafts } = session;
  const built = buildAnswers(view.entries, drafts);
  const general = normalizeGeneralQuestion(session.generalQuestion);
  if ('issue' in general) {
    session.generalIssue = general.issue;
    const card = root.querySelector('.cr-general');
    card?.replaceWith(generalQuestionBlock());
    const area = root.querySelector<HTMLElement>('#general-question');
    area?.scrollIntoView({ block: 'center' });
    area?.focus();
    return;
  }
  session.generalIssue = undefined;
  if (built.issues.length > 0) {
    // Cards re-render in place; their images come from the cache.
    session.issues = new Map(built.issues.map((item) => [item.entry_id, item.issue]));
    for (const item of built.issues) {
      const card = root.querySelector(`[data-entry="${item.entry_id}"]`);
      const entry = view.entries.find((candidate) => candidate.entry_id === item.entry_id);
      if (card && entry) {
        const index = view.entries.indexOf(entry);
        card.replaceWith(renderEntry(entry, index, view.entries.length));
      }
    }
    const first = built.issues[0];
    const invalid = root.querySelector<HTMLElement>(
      `[data-entry="${first.entry_id}"] [aria-invalid="true"]`
    );
    invalid?.scrollIntoView({ block: 'center' });
    invalid?.focus();
    return;
  }
  session.issues.clear();
  releaseImages();
  session.pendingConfirmation =
    view.participant.role === 'decider' && needsOurConfirmation(view.entries, built.answers);
  clear();
  root.append(el('h1', 'kb-page-header__title', t('review_heading')));
  root.append(
    el(
      'p',
      'kb-text',
      t(
        view.participant.role !== 'decider'
          ? 'review_lead_contributor'
          : session.pendingConfirmation
            ? 'review_lead_pending'
            : 'review_lead_decider'
      )
    )
  );
  const error = el('p', 'kb-callout cr-error');
  error.dataset.tone = 'danger';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  if (built.answers.length === 0 && !general.question) {
    root.append(el('p', 'kb-text', t('review_empty')));
  }
  const list = el('ol', 'kb-list cr-review');
  let rowNumber = 0;
  for (const answer of built.answers) {
    const entry = view.entries.find((item) => item.entry_id === answer.entry_id);
    if (!entry) continue;
    const row = el('li', 'kb-list__item');
    const body = el('div', 'kb-list__body');
    body.append(
      el('p', 'kb-list__title', `${(rowNumber += 1)}. ${entry.question}`),
      el('p', 'kb-text', answerSummary(entry, answer))
    );
    if (answer.comment) {
      body.append(el('p', 'kb-text kb-text--muted', t('review_comment', { text: answer.comment })));
    }
    row.append(body);
    list.append(row);
  }
  root.append(list);
  if (general.question) {
    const box = el('section', 'kb-callout cr-review-general');
    box.dataset.tone = 'neutral';
    box.append(
      el('h2', 'kb-text kb-text--caption', t('review_general_heading')),
      el('p', 'kb-text cr-question', general.question)
    );
    root.append(box);
  }
  root.append(error);

  const bar = el('div', 'cr-actions');
  const back = el('button', 'kb-btn kb-btn--secondary', t('back'));
  back.type = 'button';
  back.addEventListener('click', showForm);
  const submit = el('button', 'kb-btn kb-btn--primary', t('submit'));
  submit.type = 'button';
  submit.disabled = built.answers.length === 0 && !general.question;
  submit.addEventListener('click', () => {
    void send(built.answers, general.question, submit, back, error);
  });
  bar.append(back, submit);
  root.append(bar);
  focusHeading();
}

async function send(
  answers: AnswerPayload[],
  question: string | undefined,
  submit: HTMLButtonElement,
  back: HTMLButtonElement,
  error: HTMLElement
): Promise<void> {
  if (!session || !token) return;
  submit.disabled = true;
  back.disabled = true;
  submit.textContent = t('submitting');
  error.hidden = true;
  const result = await respond(fetchFn, token, session.view.content_hash, answers, question);
  const body = result.body;
  if (body && body.ok === true) {
    session.sentQuestion = question;
    showReceipt(body);
    return;
  }
  const reason = body?.reason;
  if (reason === 'invalid_answers' || reason === 'invalid_request') {
    error.textContent = t('answers_invalid');
    error.hidden = false;
    submit.disabled = false;
    back.disabled = false;
    submit.textContent = t('submit');
    return;
  }
  showState(result.status === 0 ? 'unavailable' : screenForReason(reason));
}

function showReceipt(body: Record<string, unknown>): void {
  releaseImages();
  clear();
  const decider = session?.view.participant.role === 'decider';
  const card = el('section', 'kb-callout cr-state');
  card.dataset.tone = 'success';
  card.setAttribute('role', 'status');
  card.append(
    el('h1', 'kb-callout__title', t('receipt_title')),
    el(
      'p',
      'kb-text',
      t(
        !decider
          ? 'receipt_contributor'
          : session?.pendingConfirmation
            ? 'receipt_pending'
            : 'receipt_decider'
      )
    )
  );
  const changes = typeof body.change_requests === 'number' ? body.change_requests : 0;
  if (changes > 0) card.append(el('p', 'kb-text', t('receipt_changes', { count: changes })));
  if (body.duplicate === true) card.append(el('p', 'kb-text', t('receipt_duplicate')));
  if (session?.sentQuestion) {
    card.append(
      el('p', 'kb-text', t('receipt_general')),
      el('p', 'kb-text kb-text--muted cr-question', session.sentQuestion)
    );
  }
  const again = el('button', 'kb-btn kb-btn--secondary', t('receipt_again'));
  again.type = 'button';
  again.addEventListener('click', () => {
    void restart();
  });
  card.append(again);
  root.append(card);
  focusHeading();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

let heldToken: string | null = token;

function failedView(result: ApiResult): ScreenState {
  return result.status === 0 ? 'unavailable' : screenForReason(result.body?.reason);
}

async function load(): Promise<void> {
  if (!heldToken) {
    showState('invalid_link');
    return;
  }
  releaseImages();
  showLoading();
  const result = await viewAgenda(fetchFn, heldToken);
  const body = result.body;
  if (!body || body.ok !== true) {
    showState(failedView(result));
    return;
  }
  const state = body.state;
  if (state === 'open') {
    const view = body as unknown as ViewOpen;
    setLocale(pickLocale(view.agenda.locale, navigator.languages ?? [navigator.language]));
    session = { view, drafts: new Map(), issues: new Map(), generalQuestion: '' };
    showForm();
    return;
  }
  showState(screenForReason(state));
}

async function restart(): Promise<void> {
  session = null;
  await load();
}

async function start(): Promise<void> {
  await load();
}

// Leaving the page (or the back/forward cache) releases every image URL.
window.addEventListener('pagehide', releaseImages);

setLocale(locale);
void start();
