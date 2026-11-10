import { describe, expect, it } from 'vitest';
import {
  actorDisplayName,
  ageInDays,
  boardMoveTargets,
  cardTitle,
  groupBoardColumns,
  groupIssueCards,
  orderBoardSteps,
  resolveBoardDrop,
  stepProgress,
  summarizeWorkItemDescription,
  withCardStatus,
  type BoardCard,
} from './work-item-board';

const card = (id: string, status: string, extra: Partial<BoardCard> = {}): BoardCard => ({
  id,
  title: id,
  status,
  ...extra,
});

describe('groupBoardColumns', () => {
  it('puts every card in its status column, archived and unknown statuses aside', () => {
    const grouped = groupBoardColumns([
      card('a', 'ready'),
      card('b', 'done'),
      card('c', 'archived'),
      card('d', 'mystery'),
      card('e', 'ready'),
    ]);
    expect(grouped.columns.map((column) => column.status)).toEqual([
      'backlog',
      'ready',
      'in_progress',
      'blocked',
      'review',
      'done',
    ]);
    expect(grouped.columns[1].cards.map((entry) => entry.id)).toEqual(['a', 'e']);
    expect(grouped.columns[5].cards.map((entry) => entry.id)).toEqual(['b']);
    expect(grouped.archived.map((entry) => entry.id)).toEqual(['c']);
    expect(grouped.other.map((entry) => entry.id)).toEqual(['d']);
  });

  it('orders a column urgent-first, then most recently updated', () => {
    const grouped = groupBoardColumns([
      card('old-normal', 'ready', { priority: 'normal', updatedAt: '2026-10-01T00:00:00Z' }),
      card('new-normal', 'ready', { priority: 'normal', updatedAt: '2026-11-01T00:00:00Z' }),
      card('low', 'ready', { priority: 'low', updatedAt: '2026-11-03T00:00:00Z' }),
      card('urgent', 'ready', { priority: 'urgent', updatedAt: '2026-09-01T00:00:00Z' }),
    ]);
    expect(grouped.columns[1].cards.map((entry) => entry.id)).toEqual([
      'urgent',
      'new-normal',
      'old-normal',
      'low',
    ]);
  });
});

describe('status transitions', () => {
  it('offers every other governed status, in board order', () => {
    expect(boardMoveTargets('ready')).toEqual([
      'backlog',
      'in_progress',
      'blocked',
      'review',
      'done',
      'archived',
    ]);
  });

  it('treats a drop on the same or an unknown column as no move', () => {
    expect(resolveBoardDrop('ready', 'in_progress')).toBe('in_progress');
    expect(resolveBoardDrop('ready', 'ready')).toBeNull();
    expect(resolveBoardDrop('ready', 'deleted')).toBeNull();
  });

  it('moves optimistically and rolls back to the previous status', () => {
    const before = [card('a', 'ready'), card('b', 'done')];
    const moved = withCardStatus(before, 'a', 'in_progress');
    expect(moved.map((entry) => entry.status)).toEqual(['in_progress', 'done']);
    expect(before[0].status).toBe('ready');
    expect(withCardStatus(moved, 'a', 'ready')).toEqual(before);
  });
});

describe('summarizeWorkItemDescription', () => {
  it('keeps the human lead sentence and drops the serialized plan and provenance', () => {
    const description =
      'PRODUCTION_READINESS_PLAN P0-1 を実施し scorecard を更新。Managed work plan: {"kind":"mission","missions":[{"key":"p0-1","goal":"docs {x} を実施"}]} Rationale: Continuous operations. Proposed by dot:kyberion (Owner). Contributes to: famao-ai/OBJ-1';
    const result = summarizeWorkItemDescription(description, 'P0-1 doctor/bootstrap 一本化');
    expect(result.summary).toBe('PRODUCTION_READINESS_PLAN P0-1 を実施し scorecard を更新。');
    expect(result.hasMore).toBe(true);
  });

  it('falls back to the plan goal when there is no lead sentence', () => {
    const result = summarizeWorkItemDescription(
      'Managed work plan: {"missions":[{"goal":"Unify the bootstrap"}]}',
      'P0-1'
    );
    expect(result.summary).toBe('Unify the bootstrap');
  });

  it('reads the task and deliverable of a generated mission-task description', () => {
    const result = summarizeWorkItemDescription(
      'Mission: MSN-1 Mission type: development Project: PRJ-1 Assignee role: implementer Assignee agent: architect Task: Apply the plan one change at a time Deliverable: evidence/implementation-report.md Risk: medium',
      'MSN-1: Apply the plan one change at a time'
    );
    expect(result.summary).toBe('');
    expect(result.deliverable).toBe('evidence/implementation-report.md');
    expect(result.hasMore).toBe(true);
  });

  it('returns nothing for an empty or title-only description and clamps long text', () => {
    expect(summarizeWorkItemDescription('', 'x')).toEqual({ summary: '', hasMore: false });
    expect(summarizeWorkItemDescription('Same', 'Same').summary).toBe('');
    const long = summarizeWorkItemDescription('word '.repeat(100), 't').summary;
    expect(long.length).toBeLessThanOrEqual(141);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('card text helpers', () => {
  it('drops actor kind prefixes and a mission prefix already shown as a chip', () => {
    const render = (text: { key: string } | { text: string }) =>
      'text' in text ? text.text : `[${text.key}]`;
    expect(actorDisplayName('human:concierge-localadmin', render)).toBe('concierge-localadmin');
    expect(actorDisplayName('implementation-architect', render)).toBe('implementation-architect');
    expect(actorDisplayName('pipeline:' + 'a'.repeat(64), render)).toBe('[ux_a_actor_pipeline]');
    expect(actorDisplayName('', render)).toBeUndefined();
    expect(cardTitle('MSN-1: Apply the plan', 'MSN-1')).toBe('Apply the plan');
    expect(cardTitle('MSN-1:', 'MSN-1')).toBe('MSN-1:');
    expect(cardTitle('Plain title', 'MSN-1')).toBe('Plain title');
  });

  it('computes whole days of age', () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    expect(ageInDays('2026-11-04T01:00:00Z', now)).toBe(0);
    expect(ageInDays('2026-11-01T12:00:00Z', now)).toBe(3);
    expect(ageInDays('not a date', now)).toBeNull();
    expect(ageInDays(undefined, now)).toBeNull();
  });
});

describe('Issue cards and steps (W2)', () => {
  it('turns a flat list into Issue cards carrying their step progress', () => {
    const { cards, stepsOf } = groupIssueCards([
      card('issue', 'in_progress'),
      { ...card('step-1', 'done'), parentId: 'issue' },
      { ...card('step-2', 'ready'), parentId: 'issue' },
      { ...card('orphan', 'ready'), parentId: 'hidden-issue' },
    ]);
    expect(cards.map((entry) => entry.id)).toEqual(['issue', 'orphan']);
    expect(cards[0].steps).toEqual({ total: 2, done: 1 });
    expect(cards[1].steps).toBeUndefined();
    expect(stepsOf.get('issue')?.map((step) => step.id)).toEqual(['step-1', 'step-2']);
  });

  it('describes step progress only when there are steps', () => {
    expect(stepProgress(undefined)).toBeNull();
    expect(stepProgress({ total: 0, done: 0 })).toBeNull();
    expect(stepProgress({ total: 3, done: 1 })).toEqual({ total: 3, done: 1, percent: 33 });
    expect(stepProgress({ total: 2, done: 5 })).toEqual({ total: 2, done: 2, percent: 100 });
  });

  it('orders steps along the board, unknown statuses last', () => {
    const ordered = orderBoardSteps([
      { title: 'b', status: 'done' },
      { title: 'z', status: 'mystery' },
      { title: 'a', status: 'backlog' },
      { title: 'c', status: 'done' },
    ]);
    expect(ordered.map((step) => step.title)).toEqual(['a', 'b', 'c', 'z']);
  });
});
