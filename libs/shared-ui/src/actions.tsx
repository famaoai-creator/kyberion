'use client';

import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from 'react';

/** Called when a catalog component with an `action` prop is activated. */
export type A2UIActionHandler = (actionId: string, payload?: Record<string, unknown>) => void;

/** Props the host's link component receives (compatible with `next/link`). */
export interface A2UILinkProps {
  href: string;
  className?: string;
  children?: ReactNode;
  'aria-current'?: 'page';
  'aria-disabled'?: boolean;
  'data-active'?: 'true';
  'data-nav-id'?: string;
  'data-tab-id'?: string;
}

export interface A2UIActionContextValue {
  onAction?: A2UIActionHandler;
  /**
   * Component used for internal links (e.g. `next/link`). Defaults to `<a>`.
   * Only ever receives an href that passed `safeHref`.
   */
  linkComponent?: ComponentType<A2UILinkProps>;
  /** Navigation for non-anchor targets (clickable table rows). Defaults to `location.assign`. */
  navigate?: (href: string) => void;
}

const A2UIActionContext = createContext<A2UIActionContextValue>({});

export interface A2UIActionProviderProps extends A2UIActionContextValue {
  children?: ReactNode;
}

/** Supplies the action handler (and optional link / navigation hooks) to every kb component below it. */
export function A2UIActionProvider({
  onAction,
  linkComponent,
  navigate,
  children,
}: A2UIActionProviderProps) {
  const value = useMemo(
    () => ({ onAction, linkComponent, navigate }),
    [onAction, linkComponent, navigate]
  );
  return <A2UIActionContext.Provider value={value}>{children}</A2UIActionContext.Provider>;
}

export function useA2UIActions(): A2UIActionContextValue {
  return useContext(A2UIActionContext);
}

export function defaultNavigate(href: string): void {
  if (typeof window !== 'undefined') window.location.assign(href);
}
