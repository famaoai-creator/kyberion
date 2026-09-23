'use client';

import type { ReactNode } from 'react';
import type {
  KbGridProps,
  KbNextActionProps,
  KbSectionProps,
  KbStackProps,
} from '@agent/core/a2ui-catalog';
import { asArray } from '../safety.js';
import { ActionRefButton, type ActionRefLike } from './controls.js';
import { toneAttr } from './feedback.js';

const GAPS: ReadonlySet<string> = new Set(['none', 'xs', 'sm', 'md', 'lg', 'xl']);
const ALIGNS: ReadonlySet<string> = new Set(['start', 'center', 'end', 'stretch']);
const MIN_WIDTHS: ReadonlySet<string> = new Set(['xs', 'sm', 'md', 'lg']);

function pick(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  return typeof value === 'string' && allowed.has(value) ? value : undefined;
}

export type StackProps = KbStackProps & { children?: ReactNode };

/** `ui:stack` → `.kb-stack[data-gap][data-direction][data-align][data-wrap]`. */
export function Stack({ gap, direction, align, wrap, children }: StackProps) {
  return (
    <div
      className="kb-stack"
      data-gap={pick(gap, GAPS)}
      data-direction={direction === 'horizontal' ? 'horizontal' : undefined}
      data-align={pick(align, ALIGNS)}
      data-wrap={wrap ? 'true' : undefined}
    >
      {children}
    </div>
  );
}

export type GridProps = KbGridProps & { children?: ReactNode };

/** `ui:grid` → `.kb-grid[data-gap][data-columns][data-min-column-width]` (auto-fit without `columns`). */
export function Grid({ gap, columns, min_column_width, children }: GridProps) {
  const cols =
    Number.isInteger(columns) && columns! >= 1 && columns! <= 6 ? String(columns) : undefined;
  return (
    <div
      className="kb-grid"
      data-gap={pick(gap, GAPS)}
      data-columns={cols}
      data-min-column-width={pick(min_column_width, MIN_WIDTHS)}
    >
      {children}
    </div>
  );
}

export type SectionProps = Omit<KbSectionProps, 'actions'> & {
  /**
   * Header actions: catalog refs (`href`, or `action` — an `{ id, payload? }`
   * or bare id dispatched to the `A2UIActionProvider`'s `onAction`) or
   * React-only `{ label, onClick }` refs.
   */
  actions?: ActionRefLike[];
  children?: ReactNode;
  /** Heading level for the title (default 2). */
  headingLevel?: 2 | 3 | 4;
};

/** `ui:section` → `section.kb-section[data-tone]` with `__header` (`__title`, `__description`, `__actions`). */
export function Section({
  title,
  description,
  tone,
  actions,
  headingLevel = 2,
  children,
}: SectionProps) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  const actionList = asArray(actions);
  const hasHeader = Boolean(title || description || actionList.length);
  return (
    <section className="kb-section" data-tone={toneAttr(tone)}>
      {hasHeader ? (
        <header className="kb-section__header">
          {title || description ? (
            <div className="kb-section__heading">
              {title ? <Heading className="kb-section__title">{title}</Heading> : null}
              {description ? <p className="kb-section__description">{description}</p> : null}
            </div>
          ) : null}
          {actionList.length ? (
            <div className="kb-section__actions">
              {actionList.map((action, index) => (
                <ActionRefButton key={`${action.label}-${index}`} actionRef={action} />
              ))}
            </div>
          ) : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

const NEXT_ACTION_STATES: ReadonlySet<string> = new Set(['ready', 'loading', 'empty']);

/**
 * `ui:next-action` → `section.kb-next-action[data-state]` with `__body`
 * (`__eyebrow`, `__title`, `__reason`) and `__actions`. Actions are hidden
 * while `state="loading"`.
 */
export function NextAction({
  eyebrow,
  title,
  reason,
  primary,
  secondary,
  state,
}: KbNextActionProps) {
  const resolvedState = pick(state, NEXT_ACTION_STATES) ?? 'ready';
  const showActions = resolvedState !== 'loading' && Boolean(primary || secondary);
  return (
    <section
      className="kb-next-action"
      data-state={resolvedState}
      aria-busy={resolvedState === 'loading' || undefined}
    >
      <div className="kb-next-action__body">
        {eyebrow ? <p className="kb-next-action__eyebrow">{eyebrow}</p> : null}
        <h2 className="kb-next-action__title">{title}</h2>
        {reason ? <p className="kb-next-action__reason">{reason}</p> : null}
      </div>
      {showActions ? (
        <div className="kb-next-action__actions">
          <ActionRefButton actionRef={primary} defaultVariant="primary" />
          <ActionRefButton actionRef={secondary} defaultVariant="secondary" />
        </div>
      ) : null}
    </section>
  );
}
