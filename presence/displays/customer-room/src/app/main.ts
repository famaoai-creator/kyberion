/**
 * Customer-room page. Reads the invite token from the URL fragment, removes
 * it from the address bar, then runs view -> answer -> confirm -> submit
 * against this process's own two API routes. All copy comes from the
 * `customer_room` vocabulary domain (embedded by the server, en + ja).
 */
import { respond, viewAgenda, type ApiResult, type FetchFn } from './api.js';
import {
  answeredCount,
  buildAnswers,
  describeValue,
  emptyDraft,
  keepAvailable,
  parseFragmentToken,
  pickLocale,
  screenForReason,
  sourceKey,
  type AnswerPayload,
  type Draft,
  type Locale,
  type ScreenState,
  type ViewEntry,
  type ViewOpen,
  type ViewReceipt,
} from './model.js';

type Bundle = Record<string, string>;
type Vocabulary = Record<Locale, Bundle>;

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
let locale: Locale = pickLocale(undefined, navigator.languages ?? [navigator.language]);

function t(key: string, params: Record<string, string | number> = {}): string {
  const template = vocabulary[locale][key] ?? vocabulary.en[key] ?? key;
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

function setLocale(next: Locale): void {
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
  clear();
  const keys = STATE_KEYS[state];
  const card = el('section', 'kb-callout cr-state');
  card.dataset.tone = keys.tone;
  card.setAttribute('role', 'status');
  card.append(el('h1', 'kb-callout__title', t(keys.title)), el('p', 'kb-text', t(keys.body)));
  if (state === 'stale' || state === 'unavailable') {
    const button = el(
      'button',
      'kb-btn kb-btn--primary',
      t(state === 'stale' ? 'reload' : 'retry_action')
    );
    button.type = 'button';
    button.addEventListener('click', () => {
      void start();
    });
    card.append(button);
  }
  root.append(card);
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
  switch (wording.kind) {
    case 'text':
      return t('current_line', { value: wording.text, source });
    case 'approved':
      return t('current_line', { value: t('value_approved'), source });
    case 'changes_requested':
      return t('current_line', { value: t('value_changes_requested'), source });
    default:
      return entry.requires_customer ? t('source_awaiting') : t('current_none');
  }
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
  if (entry.background) card.append(el('p', 'kb-text kb-text--muted', entry.background));

  const current = el('div', 'kb-callout cr-current');
  current.dataset.tone = 'info';
  current.append(
    el('p', 'kb-text kb-text--caption', t('current_heading')),
    el('p', 'kb-text', currentLine(entry))
  );
  card.append(current);

  const name = `choice-${entry.entry_id}`;
  const group = el('div', 'kb-choice-group');
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
    options.append(
      radio(name, t('approve'), draft.choice === 'approve', () => {
        draft.choice = 'approve';
        rerender();
      }),
      radio(name, t('request_changes'), draft.choice === 'request_changes', () => {
        draft.choice = 'request_changes';
        rerender();
      })
    );
  } else if (entry.kind === 'ranking') {
    card.append(el('p', 'kb-text kb-text--caption', t('ranking_hint')));
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
  if (entry.kind !== 'hearing') card.append(group);

  const needsComment = draft.choice === 'request_changes';
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
    updateProgress();
  });
  commentField.append(comment);
  if (needsComment) commentField.append(el('span', 'kb-field__help', t('request_changes_hint')));
  card.append(commentField);
  return card;
}

let progressNode: HTMLElement | null = null;
let reviewButton: HTMLButtonElement | null = null;

function updateProgress(): void {
  if (!session || !progressNode) return;
  const total = session.view.entries.length;
  const answered = answeredCount(session.view.entries, session.drafts);
  const remaining = total - answered;
  progressNode.textContent =
    remaining > 0 ? t('remaining', { count: remaining }) : t('remaining_done');
  if (reviewButton) reviewButton.disabled = answered === 0;
}

function showForm(): void {
  if (!session) return;
  const { view } = session;
  clear();
  const header = el('header', 'kb-page-header cr-header');
  const titles = el('div', 'kb-page-header__titles');
  titles.append(
    el('h1', 'kb-page-header__title', view.agenda.title),
    el('p', 'kb-page-header__subtitle', t('participant_line', { name: view.participant.name }))
  );
  header.append(titles);
  root.append(header);

  const role = el('div', 'kb-callout', undefined);
  role.dataset.tone = view.participant.role === 'decider' ? 'info' : 'warning';
  role.append(
    el('p', 'kb-text', t(view.participant.role === 'decider' ? 'role_decider' : 'role_contributor'))
  );
  root.append(role);

  const last = latestReceipt(view.receipts);
  if (last) {
    const note = el(
      'p',
      'kb-text kb-text--muted',
      t('previous_submission', { date: formatDate(last.submitted_at) })
    );
    root.append(note);
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
  root.append(list);

  const bar = el('div', 'cr-actions');
  reviewButton = el('button', 'kb-btn kb-btn--primary', t('review_button'));
  reviewButton.type = 'button';
  reviewButton.addEventListener('click', showReview);
  bar.append(reviewButton);
  root.append(bar);
  updateProgress();
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
  if (built.issues.length > 0) {
    const first = built.issues[0];
    const target = root.querySelector(`[data-entry="${first.entry_id}"]`);
    target?.scrollIntoView({ block: 'center' });
    return;
  }
  clear();
  root.append(el('h1', 'kb-page-header__title', t('review_heading')));
  root.append(
    el(
      'p',
      'kb-text',
      t(view.participant.role === 'decider' ? 'review_lead_decider' : 'review_lead_contributor')
    )
  );
  const error = el('p', 'kb-callout cr-error');
  error.dataset.tone = 'danger';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  if (built.answers.length === 0) {
    root.append(el('p', 'kb-text', t('review_empty')));
  }
  const list = el('ul', 'kb-list cr-review');
  for (const answer of built.answers) {
    const entry = view.entries.find((item) => item.entry_id === answer.entry_id);
    if (!entry) continue;
    const row = el('li', 'kb-list__item');
    const body = el('div', 'kb-list__body');
    body.append(
      el('p', 'kb-list__title', entry.question),
      el('p', 'kb-text', answerSummary(entry, answer))
    );
    if (answer.comment) {
      body.append(el('p', 'kb-text kb-text--muted', t('review_comment', { text: answer.comment })));
    }
    row.append(body);
    list.append(row);
  }
  root.append(list, error);

  const bar = el('div', 'cr-actions');
  const back = el('button', 'kb-btn kb-btn--secondary', t('back'));
  back.type = 'button';
  back.addEventListener('click', showForm);
  const submit = el('button', 'kb-btn kb-btn--primary', t('submit'));
  submit.type = 'button';
  submit.disabled = built.answers.length === 0;
  submit.addEventListener('click', () => {
    void send(built.answers, submit, back, error);
  });
  bar.append(back, submit);
  root.append(bar);
}

async function send(
  answers: AnswerPayload[],
  submit: HTMLButtonElement,
  back: HTMLButtonElement,
  error: HTMLElement
): Promise<void> {
  if (!session || !token) return;
  submit.disabled = true;
  back.disabled = true;
  submit.textContent = t('submitting');
  error.hidden = true;
  const result = await respond(fetchFn, token, session.view.content_hash, answers);
  const body = result.body;
  if (body && body.ok === true) {
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
  clear();
  const decider = session?.view.participant.role === 'decider';
  const card = el('section', 'kb-callout cr-state');
  card.dataset.tone = 'success';
  card.setAttribute('role', 'status');
  card.append(
    el('h1', 'kb-callout__title', t('receipt_title')),
    el('p', 'kb-text', t(decider ? 'receipt_decider' : 'receipt_contributor'))
  );
  const changes = typeof body.change_requests === 'number' ? body.change_requests : 0;
  if (changes > 0) card.append(el('p', 'kb-text', t('receipt_changes', { count: changes })));
  if (body.duplicate === true) card.append(el('p', 'kb-text', t('receipt_duplicate')));
  const again = el('button', 'kb-btn kb-btn--secondary', t('receipt_again'));
  again.type = 'button';
  again.addEventListener('click', () => {
    void restart();
  });
  card.append(again);
  root.append(card);
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
    session = { view, drafts: new Map() };
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

setLocale(locale);
void start();
