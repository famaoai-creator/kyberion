'use client';

import type { MouseEvent, ReactNode } from 'react';
import type {
  KbAction,
  KbActionRef,
  KbButtonProps,
  KbButtonVariant,
  KbDisclosureProps,
} from '@agent/core/a2ui-catalog';
import { useA2UIActions, type A2UILinkProps } from '../actions.js';
import { KB_UI_MESSAGE_KEYS, useKbI18n } from '../i18n.js';
import { safeHref } from '../safety.js';

const BUTTON_VARIANTS: ReadonlySet<string> = new Set(['primary', 'secondary', 'danger', 'ghost']);

function variantOf(value: unknown, fallback: KbButtonVariant): KbButtonVariant {
  return typeof value === 'string' && BUTTON_VARIANTS.has(value)
    ? (value as KbButtonVariant)
    : fallback;
}

/** An `<a>` (or the host's link component) for an href already checked by `safeHref`. */
export function KbLink(props: A2UILinkProps) {
  const { linkComponent: LinkComponent } = useA2UIActions();
  if (LinkComponent) return <LinkComponent {...props} />;
  const { children, ...rest } = props;
  return <a {...rest}>{children}</a>;
}

/**
 * Props for `Button`: the catalog `ui:button` contract (`KbButtonProps`
 * is assignable to it) plus React-only conveniences.
 */
export interface ButtonProps {
  label: string;
  variant?: KbButtonVariant;
  disabled?: boolean;
  href?: string;
  /** Native `title` attribute (tooltip / accessible description), on either the link or the button. */
  title?: string;
  /** Link target, only meaningful with `href`. `_blank` always gets `rel="noopener"`. */
  target?: '_blank' | '_self';
  /** Dispatched through the enclosing `A2UIActionProvider`'s `onAction` (an id alone = no payload). */
  action?: KbAction | string;
  /**
   * React-only click handler; runs before the context `onAction` dispatch,
   * and alongside `href` (before navigation, unless it calls `preventDefault`).
   */
  onClick?: (event: MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => void;
  type?: 'button' | 'submit' | 'reset';
  /** Replaces the visible label (the label stays the accessible name). */
  children?: ReactNode;
}

/** `ui:button` → `.kb-btn.kb-btn--{variant}`; a link when `href` is safe, else a `<button>`. */
export function Button(props: ButtonProps) {
  const { onAction } = useA2UIActions();
  const variant = variantOf(props.variant, 'secondary');
  const className = `kb-btn kb-btn--${variant}`;
  const content = props.children ?? props.label;

  if (props.href !== undefined) {
    const href = safeHref(props.href);
    if (href && !props.disabled) {
      return (
        <KbLink
          href={href}
          className={className}
          title={props.title}
          target={props.target}
          rel={props.target === '_blank' ? 'noopener' : undefined}
          onClick={props.onClick}
        >
          {content}
        </KbLink>
      );
    }
    // Unsafe or disabled link: keep the visual, drop the navigation target.
    return (
      <a
        className={className}
        aria-disabled="true"
        role="link"
        aria-label={props.label}
        title={props.title}
      >
        {content}
      </a>
    );
  }

  const action = normalizeAction(props.action);
  return (
    <button
      type={props.type ?? 'button'}
      className={className}
      disabled={props.disabled || undefined}
      title={props.title}
      data-action-id={action?.id}
      aria-label={props.children ? props.label : undefined}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented && action && onAction) onAction(action.id, action.payload);
      }}
    >
      {content}
    </button>
  );
}

/** `{ id, payload? }` or a bare action id → `KbAction`; anything else → undefined. */
export function normalizeAction(action: KbAction | string | undefined): KbAction | undefined {
  if (typeof action === 'string') return action ? { id: action } : undefined;
  return action && typeof action.id === 'string' && action.id ? action : undefined;
}

/**
 * React-only action reference: the catalog `KbActionRef` shape with an
 * `onClick` handler instead of (or in addition to) an `action`. Hosts use it
 * for in-page handlers; an `action` still dispatches through the enclosing
 * `A2UIActionProvider` after `onClick` (unless it calls `preventDefault`).
 */
export interface KbReactActionRef {
  label: string;
  variant?: KbButtonVariant;
  disabled?: boolean;
  action?: KbAction | string;
  onClick: (event: MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => void;
  href?: never;
}

/** An action reference accepted by React components with `actions` (catalog or React-only). */
export type ActionRefLike = KbActionRef | KbReactActionRef;

/** Render a catalog `KbActionRef` (label + href | action) or a `KbReactActionRef` as a `Button`. */
export function ActionRefButton({
  actionRef,
  defaultVariant = 'secondary',
}: {
  actionRef: ActionRefLike | undefined;
  defaultVariant?: KbButtonVariant;
}) {
  if (!actionRef || typeof actionRef.label !== 'string') return null;
  const onClick = 'onClick' in actionRef ? actionRef.onClick : undefined;
  return (
    <Button
      label={actionRef.label}
      variant={variantOf(actionRef.variant, defaultVariant)}
      disabled={actionRef.disabled}
      href={actionRef.href}
      action={actionRef.action}
      onClick={typeof onClick === 'function' ? onClick : undefined}
    />
  );
}

// Compile-time guarantee that the catalog props are accepted as-is.
const _catalogButtonIsAccepted = (props: KbButtonProps): ButtonProps => props;
void _catalogButtonIsAccepted;

export type DisclosureProps = KbDisclosureProps & { children?: ReactNode };

/** `ui:disclosure` → `<details class="kb-disclosure">` with a `.kb-disclosure__body`. */
export function Disclosure({ summary, open, children }: DisclosureProps) {
  const { t } = useKbI18n();
  return (
    <details className="kb-disclosure" open={open || undefined}>
      <summary>{summary || t(KB_UI_MESSAGE_KEYS.disclosureSummary)}</summary>
      <div className="kb-disclosure__body">{children}</div>
    </details>
  );
}
