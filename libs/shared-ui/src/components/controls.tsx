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
  action?: KbAction;
  /** React-only click handler; runs before the context `onAction` dispatch. */
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
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
        <KbLink href={href} className={className}>
          {content}
        </KbLink>
      );
    }
    // Unsafe or disabled link: keep the visual, drop the navigation target.
    return (
      <a className={className} aria-disabled="true" role="link" aria-label={props.label}>
        {content}
      </a>
    );
  }

  const action = props.action;
  return (
    <button
      type={props.type ?? 'button'}
      className={className}
      disabled={props.disabled || undefined}
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

/** Render a catalog `KbActionRef` (label + href | action) as a `Button`. */
export function ActionRefButton({
  actionRef,
  defaultVariant = 'secondary',
}: {
  actionRef: KbActionRef | undefined;
  defaultVariant?: KbButtonVariant;
}) {
  if (!actionRef || typeof actionRef.label !== 'string') return null;
  return (
    <Button
      label={actionRef.label}
      variant={variantOf(actionRef.variant, defaultVariant)}
      disabled={actionRef.disabled}
      href={actionRef.href}
      action={actionRef.action}
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
