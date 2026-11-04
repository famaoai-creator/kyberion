'use client';

import * as React from 'react';
import { A2UIActionProvider, Badge, Callout, Dialog } from '@agent/shared-ui';
import type { KbTone } from '@agent/core/surface/a2ui-catalog';
import {
  ageInDays,
  boardMoveTargets,
  cardTitle,
  groupBoardColumns,
  resolveBoardDrop,
  summarizeWorkItemDescription,
  withCardStatus,
  type BoardCard,
} from './work-item-board';
import './work-item-board.css';

export type BoardTranslate = (key: string, params?: Record<string, string | number>) => string;
export type BoardViewMode = 'board' | 'list';

const PRIORITY_TONE: Record<string, KbTone> = {
  urgent: 'danger',
  high: 'warning',
  normal: 'neutral',
  low: 'neutral',
};

const DRAG_TYPE = 'application/x-kyberion-work-item';

/** Board / list switch, shared by `/w/work_item` and the console work board. */
export function BoardViewToggle({
  t,
  view,
  onChange,
}: {
  t: BoardTranslate;
  view: BoardViewMode;
  onChange: (view: BoardViewMode) => void;
}) {
  return (
    <div className="wb-toggle" role="group" aria-label={t('ux_b_board_view_label')}>
      {(['board', 'list'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          className="wb-toggle__option"
          aria-pressed={view === mode}
          onClick={() => onChange(mode)}
        >
          {t(`ux_b_board_view_${mode}`)}
        </button>
      ))}
    </div>
  );
}

export interface WorkItemBoardProps<T extends BoardCard> {
  cards: readonly T[];
  t: BoardTranslate;
  statusLabel: (status: string) => string;
  /** BCP-47 tag for relative ages. */
  locale: string;
  /** False for readonly viewers: no drag handles, no status menu. */
  canMove: boolean;
  /** Sends the governed status update; must throw when the server refuses. */
  onMove?: (card: T, status: string) => Promise<void>;
  /** Extra controls under a card (console only: alignment action, discussion links). */
  renderCardExtra?: (card: T) => React.ReactNode;
  label: string;
  /** `list`: the same status groups stacked, empty ones omitted (same move path). */
  layout?: BoardViewMode;
}

type PendingMove<T> = { card: T; to: string };

/**
 * Work items as a kanban board: one column per status, cards that read at a
 * glance (title, priority, assignee, project › mission, age), and status
 * changes by drag-and-drop or the per-card "状態を変更" menu. Every move asks
 * for confirmation, shows optimistically, and goes back when the server
 * refuses it.
 */
export function WorkItemBoard<T extends BoardCard>({
  cards,
  t,
  statusLabel,
  locale,
  canMove,
  onMove,
  renderCardExtra,
  label,
  layout = 'board',
}: WorkItemBoardProps<T>) {
  const [overrides, setOverrides] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState<PendingMove<T> | null>(null);
  const [saving, setSaving] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<string | null>(null);
  const movable = canMove && Boolean(onMove);

  // Moves the server confirmed: the next refresh is authoritative for them.
  const settledRef = React.useRef<Set<string>>(new Set());
  // The card whose move control gets keyboard focus back after its move.
  const [focusCard, setFocusCard] = React.useState<string | null>(null);
  const moveControls = React.useRef<Map<string, HTMLSelectElement>>(new Map());

  // A refresh retires an override once it shows the moved status, or once the
  // server confirmed the move (then its status wins, even if another operator
  // moved the card meanwhile), so a stale optimistic column never sticks.
  React.useEffect(() => {
    const settled = settledRef.current;
    setOverrides((current) => {
      const next = { ...current };
      let changed = false;
      for (const card of cards) {
        if (next[card.id] === undefined) continue;
        if (next[card.id] === card.status || settled.has(card.id)) {
          delete next[card.id];
          settled.delete(card.id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [cards]);

  // The moved card remounts in its new column, so the Dialog's own focus
  // restore lands on a detached control; put focus back on the moved card's
  // control once its save ends (a disabled control cannot take focus).
  React.useEffect(() => {
    if (!focusCard || saving === focusCard) return;
    const timer = setTimeout(() => {
      moveControls.current.get(focusCard)?.focus();
      setFocusCard(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [focusCard, saving, overrides]);

  const effective = React.useMemo(
    () =>
      Object.entries(overrides).reduce<T[]>(
        (list, [id, status]) => withCardStatus(list, id, status),
        [...cards]
      ),
    [cards, overrides]
  );
  const grouped = React.useMemo(() => groupBoardColumns(effective), [effective]);
  const now = Date.now();
  const relative = React.useMemo(() => {
    try {
      return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    } catch {
      return new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    }
  }, [locale]);

  const propose = (card: T, to: string) => {
    const target = resolveBoardDrop(card.status, to);
    if (!movable || !target) return;
    setFailure(null);
    setPending({ card, to: target });
  };

  const confirm = async () => {
    if (!pending || !onMove) return;
    const { card, to } = pending;
    setPending(null);
    setSaving(card.id);
    setFocusCard(card.id);
    settledRef.current.delete(card.id);
    setOverrides((current) => ({ ...current, [card.id]: to }));
    try {
      await onMove(card, to);
      settledRef.current.add(card.id);
    } catch {
      setOverrides((current) => {
        const next = { ...current };
        delete next[card.id];
        return next;
      });
      setFailure(t('ux_b_move_failed', { title: cardTitle(card.title, card.mission?.id) }));
    } finally {
      setSaving(null);
    }
  };

  const renderCard = (card: T) => {
    const title = cardTitle(card.title, card.mission?.id);
    const described = summarizeWorkItemDescription(card.description, title);
    const age = ageInDays(card.updatedAt, now);
    const lineage = [card.project, card.mission].filter((ref): ref is NonNullable<typeof ref> =>
      Boolean(ref)
    );
    return (
      <li
        key={card.id}
        className="wb-card"
        data-saving={saving === card.id ? 'true' : undefined}
        draggable={movable}
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, card.id);
          event.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => setDropTarget(null)}
      >
        <div className="wb-card__head">
          {card.href ? (
            <a className="wb-card__title" href={card.href} title={card.title}>
              {title}
            </a>
          ) : (
            <span className="wb-card__title" title={card.title}>
              {title}
            </span>
          )}
          {card.priority && card.priority !== 'normal' ? (
            <Badge
              tone={PRIORITY_TONE[card.priority] ?? 'neutral'}
              label={t(`ux_b_priority_${card.priority}`)}
            />
          ) : null}
        </div>
        {described.summary ? <p className="wb-card__summary">{described.summary}</p> : null}
        {lineage.length ? (
          <p className="wb-card__lineage">
            <span className="wb-visually-hidden">{t('ux_b_lineage_label')}: </span>
            {lineage.map((ref) => ref.label).join(' › ')}
          </p>
        ) : null}
        <p className="wb-card__meta">
          <span>{card.assignee || t('ux_b_card_unassigned')}</span>
          {age !== null ? (
            <time dateTime={card.updatedAt}>
              {t('ux_b_card_updated', { age: relative.format(-age, 'day') })}
            </time>
          ) : null}
        </p>
        {described.hasMore || described.deliverable ? (
          <details className="wb-card__more">
            <summary>{t('ux_b_card_details')}</summary>
            {described.deliverable ? (
              <p>{t('ux_b_card_deliverable', { path: described.deliverable })}</p>
            ) : null}
            <p className="wb-card__full">{card.description}</p>
            <p className="wb-card__id">{card.id}</p>
          </details>
        ) : null}
        {renderCardExtra ? renderCardExtra(card) : null}
        {movable ? (
          <label className="wb-card__move">
            <span className="wb-visually-hidden">
              {t('ux_b_card_move_label')}: {title}
            </span>
            <select
              ref={(element) => {
                if (element) moveControls.current.set(card.id, element);
                else moveControls.current.delete(card.id);
              }}
              className="kb-input kb-select wb-card__move-select"
              value=""
              disabled={saving === card.id}
              onChange={(event) => {
                const to = event.target.value;
                event.target.value = '';
                if (to) propose(card, to);
              }}
            >
              <option value="">
                {saving === card.id ? t('ux_b_move_saving') : t('ux_b_card_move_placeholder')}
              </option>
              {boardMoveTargets(card.status).map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </li>
    );
  };

  const columnProps = (status: string) =>
    movable
      ? {
          onDragOver: (event: React.DragEvent) => {
            if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            if (dropTarget !== status) setDropTarget(status);
          },
          onDragLeave: () => setDropTarget((current) => (current === status ? null : current)),
          onDrop: (event: React.DragEvent) => {
            event.preventDefault();
            setDropTarget(null);
            const id = event.dataTransfer.getData(DRAG_TYPE);
            const card = effective.find((entry) => entry.id === id);
            if (card) propose(card, status);
          },
        }
      : {};

  const collapsed = (status: string, list: T[]) =>
    list.length ? (
      <details className="wb-collapsed" {...columnProps(status)}>
        <summary>
          {t('ux_b_board_collapsed_count', { label: statusLabel(status), count: list.length })}
        </summary>
        <ul className="wb-column__cards">{list.map(renderCard)}</ul>
      </details>
    ) : null;

  return (
    <div className="wb-board-wrap">
      {failure ? (
        <div role="alert">
          <Callout tone="danger" title={failure} />
        </div>
      ) : null}
      {!movable ? <p className="wb-hint">{t('ux_b_board_readonly')}</p> : null}
      <div className="wb-board" data-layout={layout} role="list" aria-label={label}>
        {grouped.columns
          .filter((column) => layout === 'board' || column.cards.length > 0)
          .map((column) => (
            <section
              key={column.status}
              role="listitem"
              className="wb-column"
              data-status={column.status}
              data-drop={dropTarget === column.status ? 'true' : undefined}
              data-empty={column.cards.length === 0 && layout === 'board' ? 'true' : undefined}
              aria-label={`${statusLabel(column.status)} (${column.cards.length})`}
              {...columnProps(column.status)}
            >
              <h3 className="wb-column__title">
                <span>{statusLabel(column.status)}</span>
                <span className="wb-column__count">{column.cards.length}</span>
              </h3>
              {column.cards.length ? (
                <ul className="wb-column__cards">{column.cards.map(renderCard)}</ul>
              ) : (
                <p className="wb-column__empty">{t('ux_b_board_column_empty')}</p>
              )}
            </section>
          ))}
      </div>
      {collapsed('archived', grouped.archived)}
      {grouped.other.length ? (
        <details className="wb-collapsed" open>
          <summary>
            {t('ux_b_board_collapsed_count', {
              label: t('ux_b_board_other'),
              count: grouped.other.length,
            })}
          </summary>
          <ul className="wb-column__cards">{grouped.other.map(renderCard)}</ul>
        </details>
      ) : null}
      <A2UIActionProvider
        onAction={(id) => {
          if (id === 'workboard.move.confirm') void confirm();
          else setPending(null);
        }}
      >
        <Dialog
          id="workboard-move"
          open={pending !== null}
          title={t('ux_b_move_confirm_title')}
          message={
            pending
              ? t('ux_b_move_confirm_message', {
                  title: cardTitle(pending.card.title, pending.card.mission?.id),
                  from: statusLabel(pending.card.status),
                  to: statusLabel(pending.to),
                })
              : ''
          }
          confirm_label={t('ux_b_move_confirm')}
          cancel_label={t('ux_b_move_cancel')}
          action={{ id: 'workboard.move.confirm' }}
          cancel_action={{ id: 'workboard.move.cancel' }}
        />
      </A2UIActionProvider>
    </div>
  );
}
