'use client';

import { useEffect, type ReactNode } from 'react';
import type {
  KbAppShellProps,
  KbNavItem,
  KbNavRailProps,
  KbPageHeaderProps,
  KbTabsProps,
} from '@agent/core/a2ui-catalog';
import { useA2UIActions } from '../actions.js';
import { TABS_SELECT_ACTION } from '../catalog.js';
import { KB_ICON_NAMES, KbIcon } from '../icons.js';
import { asArray, safeHref } from '../safety.js';
import { ActionRefButton, KbLink } from './controls.js';
import { Badge, roleAttr } from './feedback.js';

export type AppShellProps = KbAppShellProps & {
  /** Slot for the navigation (normally a `NavRail`). */
  nav?: ReactNode;
  /** Main column content (page header, sections, ...). */
  children?: ReactNode;
};

/**
 * `ui:app-shell` → `.kb-app-shell[data-density][data-theme][data-role]` with
 * `__nav` and `main.__main` slots. The token stylesheet scopes themes to
 * `:root[data-theme]`, so an explicit `theme` is also mirrored onto
 * `<html>` while the shell is mounted (`system` clears it).
 */
export function AppShell({ density, theme, role, nav, children }: AppShellProps) {
  useEffect(() => {
    if (!theme || typeof document === 'undefined') return undefined;
    const root = document.documentElement;
    const previous = root.getAttribute('data-theme');
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    return () => {
      if (previous === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', previous);
    };
  }, [theme]);

  return (
    <div
      className="kb-app-shell"
      data-density={density === 'compact' ? 'compact' : 'comfortable'}
      data-theme={theme === 'light' || theme === 'dark' ? theme : undefined}
      data-role={roleAttr(role)}
    >
      {nav ? <div className="kb-app-shell__nav">{nav}</div> : null}
      <main className="kb-app-shell__main">{children}</main>
    </div>
  );
}

export type PageHeaderProps = KbPageHeaderProps & { children?: ReactNode };

/** `ui:page-header` → `header.kb-page-header` (`__titles` > `h1.__title` + `__subtitle`, `__actions`). */
export function PageHeader({ title, subtitle, role_badge, actions, children }: PageHeaderProps) {
  const actionList = asArray(actions);
  return (
    <header className="kb-page-header">
      <div className="kb-page-header__titles">
        <h1 className="kb-page-header__title">
          {title}
          {role_badge?.label ? (
            <Badge label={role_badge.label} tone={role_badge.tone} role={role_badge.role} />
          ) : null}
        </h1>
        {subtitle ? <p className="kb-page-header__subtitle">{subtitle}</p> : null}
      </div>
      {actionList.length || children ? (
        <div className="kb-page-header__actions">
          {actionList.map((action, index) => (
            <ActionRefButton key={`${action.label}-${index}`} actionRef={action} />
          ))}
          {children}
        </div>
      ) : null}
    </header>
  );
}

function NavRailItem({ item }: { item: KbNavItem }) {
  const href = safeHref(item.href);
  const active = item.active === true;
  const inner = (
    <>
      {item.icon && KB_ICON_NAMES.includes(item.icon) ? (
        <span className="kb-nav-rail__icon" aria-hidden="true">
          <KbIcon name={item.icon} />
        </span>
      ) : null}
      <span className="kb-nav-rail__text">
        <span className="kb-nav-rail__label">{item.label}</span>
        {item.hint ? <span className="kb-nav-rail__hint">{item.hint}</span> : null}
      </span>
    </>
  );
  return (
    <li>
      {href ? (
        <KbLink
          href={href}
          className="kb-nav-rail__item"
          aria-current={active ? 'page' : undefined}
          data-active={active ? 'true' : undefined}
        >
          {inner}
        </KbLink>
      ) : (
        <span
          className="kb-nav-rail__item"
          aria-current={active ? 'page' : undefined}
          data-active={active ? 'true' : undefined}
        >
          {inner}
        </span>
      )}
    </li>
  );
}

/** `ui:nav-rail` → `nav.kb-nav-rail` (`ul.__list` of `a.__item`, optional `__footer`). */
export function NavRail({
  label,
  items,
  footer_items,
  children,
}: KbNavRailProps & { children?: ReactNode }) {
  const footer = asArray(footer_items);
  return (
    <nav className="kb-nav-rail" aria-label={label || 'メインメニュー'}>
      {children}
      <ul className="kb-nav-rail__list">
        {asArray(items).map((item) => (
          <NavRailItem key={item.id} item={item} />
        ))}
      </ul>
      {footer.length ? (
        <div className="kb-nav-rail__footer">
          <ul className="kb-nav-rail__list">
            {footer.map((item) => (
              <NavRailItem key={item.id} item={item} />
            ))}
          </ul>
        </div>
      ) : null}
    </nav>
  );
}

export type TabsProps = KbTabsProps & {
  /** Called with the tab id when a button tab (no `href`) is chosen. */
  onSelect?: (id: string) => void;
  /** Accessible name of the tab list. */
  label?: string;
};

/**
 * `ui:tabs` → `.kb-tabs[data-overflow]` of `.kb-tabs__tab` (+ `__count`).
 * With hrefs it is a link bar (`aria-current="page"`); otherwise an ARIA
 * tablist of buttons (`aria-selected`).
 */
export function Tabs({ items, active, overflow, onSelect, label }: TabsProps) {
  const { onAction } = useA2UIActions();
  const list = asArray(items);
  const linkMode = list.some((item) => item.href !== undefined);
  const overflowAttr = overflow === 'menu' ? 'menu' : 'wrap';
  const count = (value: number | undefined) =>
    typeof value === 'number' ? <span className="kb-tabs__count">{value}</span> : null;

  if (linkMode) {
    return (
      <nav className="kb-tabs" data-overflow={overflowAttr} aria-label={label}>
        {list.map((item) => {
          const href = safeHref(item.href);
          const current = item.id === active ? 'page' : undefined;
          return href ? (
            <KbLink key={item.id} href={href} className="kb-tabs__tab" aria-current={current}>
              {item.label}
              {count(item.count)}
            </KbLink>
          ) : (
            <span
              key={item.id}
              className="kb-tabs__tab"
              aria-current={current}
              aria-disabled="true"
            >
              {item.label}
              {count(item.count)}
            </span>
          );
        })}
      </nav>
    );
  }

  return (
    <div className="kb-tabs" data-overflow={overflowAttr} role="tablist" aria-label={label}>
      {list.map((item) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            className="kb-tabs__tab"
            aria-selected={selected}
            onClick={() => {
              if (onSelect) onSelect(item.id);
              else onAction?.(TABS_SELECT_ACTION, { id: item.id });
            }}
          >
            {item.label}
            {count(item.count)}
          </button>
        );
      })}
    </div>
  );
}
