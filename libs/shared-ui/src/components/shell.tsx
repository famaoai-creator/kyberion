'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type {
  KbAppShellProps,
  KbNavBrand,
  KbNavContext,
  KbNavItem,
  KbNavRailProps,
  KbPageHeaderProps,
  KbTabsProps,
} from '@agent/core/a2ui-catalog';
import {
  navBrandLogo,
  navContextOptions,
  navContextPayload,
  tabsVariant,
} from '../../vanilla/kyberion-ui.js';
import { useA2UIActions } from '../actions.js';
import { TABS_SELECT_ACTION } from '../catalog.js';
import { KB_UI_MESSAGE_KEYS, useKbI18n } from '../i18n.js';
import { KB_ICON_NAMES, KbIcon } from '../icons.js';
import { asArray, safeHref } from '../safety.js';
import { ActionRefButton, KbLink, type ActionRefLike } from './controls.js';
import { Badge, roleAttr } from './feedback.js';

/** Custom properties only (`--brand-accent`, ...): tenant brand variables, never raw styling. */
export type AppShellStyle = Readonly<Record<`--${string}`, string | number>>;

export type AppShellProps = KbAppShellProps & {
  /** Slot for the navigation (normally a `NavRail`). */
  nav?: ReactNode;
  /** Main column content (page header, sections, ...). */
  children?: ReactNode;
  /** Extra classes on the `.kb-app-shell` root (React-only). */
  className?: string;
  /**
   * CSS custom properties on the root (React-only), e.g. tenant brand
   * variables. Anything that is not a `--*` property is dropped.
   */
  style?: AppShellStyle;
};

/** Keep only `--*` custom properties with string / finite-number values. */
export function customPropertiesOnly(style: unknown): CSSProperties | undefined {
  if (!style || typeof style !== 'object') return undefined;
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(style as Record<string, unknown>)) {
    if (!/^--[A-Za-z0-9_-]+$/.test(name)) continue;
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
      out[name] = value;
    }
  }
  return Object.keys(out).length ? (out as CSSProperties) : undefined;
}

/**
 * `ui:app-shell` → `.kb-app-shell[data-density][data-theme][data-role]` with
 * `__nav` and `main.__main` slots. `data-density` / `data-theme` are set only
 * when the prop is explicitly given (page-level density/theme wins
 * otherwise), matching the vanilla renderer. The token stylesheet scopes
 * themes to `:root[data-theme]`, so an explicit `theme` is also mirrored onto
 * `<html>` while the shell is mounted (`system` clears it).
 */
export function AppShell({ density, theme, role, nav, children, className, style }: AppShellProps) {
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
      className={className ? `kb-app-shell ${className}` : 'kb-app-shell'}
      style={customPropertiesOnly(style)}
      data-density={density === 'comfortable' || density === 'compact' ? density : undefined}
      data-theme={theme === 'light' || theme === 'dark' ? theme : undefined}
      data-role={roleAttr(role)}
    >
      {nav ? <div className="kb-app-shell__nav">{nav}</div> : null}
      <main className="kb-app-shell__main">{children}</main>
    </div>
  );
}

export type PageHeaderProps = Omit<KbPageHeaderProps, 'actions'> & {
  /** Catalog refs or React-only `{ label, onClick }` refs (see `SectionProps.actions`). */
  actions?: ActionRefLike[];
  children?: ReactNode;
};

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
          data-nav-id={item.id}
          aria-current={active ? 'page' : undefined}
          data-active={active ? 'true' : undefined}
        >
          {inner}
        </KbLink>
      ) : (
        <span
          className="kb-nav-rail__item"
          data-nav-id={item.id}
          aria-current={active ? 'page' : undefined}
          data-active={active ? 'true' : undefined}
        >
          {inner}
        </span>
      )}
    </li>
  );
}

/** `ui:nav-rail` brand slot → `.kb-nav-rail__brand` (logo or mark + name / subtitle). */
function NavBrand({ brand }: { brand: KbNavBrand }) {
  const logo = navBrandLogo(brand.logo_url);
  return (
    <div className="kb-nav-rail__brand">
      {logo ? (
        <img className="kb-nav-rail__brand-logo" src={logo} alt="" />
      ) : (
        <span className="kb-nav-rail__brand-mark" aria-hidden="true" />
      )}
      <span className="kb-nav-rail__brand-text">
        <strong className="kb-nav-rail__brand-name">{brand.name}</strong>
        {brand.subtitle ? (
          <span className="kb-nav-rail__brand-subtitle">{brand.subtitle}</span>
        ) : null}
      </span>
    </div>
  );
}

function NavContextBody({ context, hiddenLabel }: { context: KbNavContext; hiddenLabel?: string }) {
  return (
    <>
      {hiddenLabel ? <span className="kb-visually-hidden">{hiddenLabel}</span> : null}
      <span className="kb-nav-rail__context-label">{context.label}</span>
      {context.detail ? (
        <span className="kb-nav-rail__context-detail">{context.detail}</span>
      ) : null}
    </>
  );
}

/**
 * `ui:nav-rail` context slot → `.kb-nav-rail__context`: options + action =
 * switcher (button + listbox; choosing dispatches `action` with `{ value }`),
 * action alone = button, href alone = link, else static text. Same markup as
 * the vanilla renderer (the option list is always rendered, `hidden` when
 * closed).
 */
function NavContext({ context }: { context: KbNavContext }) {
  const { onAction } = useA2UIActions();
  const { t } = useKbI18n();
  const [open, setOpen] = useState(false);
  const action = context.action && typeof context.action.id === 'string' ? context.action : null;
  const options = navContextOptions(context);
  const switchLabel = context.switch_label || t(KB_UI_MESSAGE_KEYS.navContextSwitch);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && open) setOpen(false);
    },
    [open]
  );
  // A pointer press outside the block closes the open list (like Escape).
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const onOutside = (event: Event) => {
      const root = rootRef.current;
      if (root && root.contains(event.target as Node | null)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, [open]);
  if (action && options.length > 0) {
    return (
      <div className="kb-nav-rail__context" ref={rootRef} onKeyDown={onKeyDown}>
        <button
          type="button"
          className="kb-nav-rail__context-button"
          aria-haspopup="listbox"
          aria-expanded={open ? 'true' : 'false'}
          onClick={() => setOpen((previous) => !previous)}
        >
          <NavContextBody context={context} hiddenLabel={switchLabel} />
        </button>
        <ul
          className="kb-nav-rail__context-menu"
          role="listbox"
          aria-label={switchLabel}
          hidden={!open}
        >
          {options.map((option) => (
            <li key={option.value} role="presentation">
              <button
                type="button"
                className="kb-nav-rail__context-option"
                role="option"
                aria-selected={option.selected === true ? 'true' : 'false'}
                data-value={option.value}
                onClick={() => {
                  setOpen(false);
                  onAction?.(action.id, navContextPayload(action, option.value));
                }}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (action) {
    return (
      <div className="kb-nav-rail__context">
        <button
          type="button"
          className="kb-nav-rail__context-button"
          data-action-id={action.id}
          onClick={() => onAction?.(action.id, action.payload)}
        >
          <NavContextBody context={context} hiddenLabel={switchLabel} />
        </button>
      </div>
    );
  }
  const href = safeHref(context.href);
  if (href) {
    return (
      <div className="kb-nav-rail__context">
        <KbLink href={href} className="kb-nav-rail__context-button">
          <NavContextBody context={context} hiddenLabel={switchLabel} />
        </KbLink>
      </div>
    );
  }
  return (
    <div className="kb-nav-rail__context">
      <div className="kb-nav-rail__context-button" data-static="true">
        <NavContextBody context={context} />
      </div>
    </div>
  );
}

/**
 * `ui:nav-rail` → `nav.kb-nav-rail` (optional `__brand` and `__context`
 * slots, `ul.__list` of `a.__item`, optional `__footer`).
 */
export function NavRail({
  label,
  brand,
  context,
  items,
  footer_items,
  children,
}: KbNavRailProps & { children?: ReactNode }) {
  const { t } = useKbI18n();
  const footer = asArray(footer_items);
  return (
    <nav className="kb-nav-rail" aria-label={label || t(KB_UI_MESSAGE_KEYS.navLabel)}>
      {brand && typeof brand.name === 'string' && brand.name ? <NavBrand brand={brand} /> : null}
      {context && typeof context.label === 'string' && context.label ? (
        <NavContext context={context} />
      ) : null}
      {children}
      {asArray(items).length ? (
        <ul className="kb-nav-rail__list">
          {asArray(items).map((item) => (
            <NavRailItem key={item.id} item={item} />
          ))}
        </ul>
      ) : null}
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
  /** Accessible name of the tab list (default: the localized `ui:tabs_label`). */
  label?: string;
};

/**
 * `ui:tabs` → `.kb-tabs[data-overflow]` of `.kb-tabs__tab` (+ `__count`).
 * With hrefs it is a link bar (`aria-current="page"`); otherwise an ARIA
 * tablist of buttons (`aria-selected`).
 */
export function Tabs({ items, active, overflow, variant, onSelect, label }: TabsProps) {
  const { onAction } = useA2UIActions();
  const { t } = useKbI18n();
  const tabsLabel = label || t(KB_UI_MESSAGE_KEYS.tabsLabel);
  const list = asArray(items);
  const linkMode = list.some((item) => item.href !== undefined);
  const overflowAttr = overflow === 'menu' ? 'menu' : 'wrap';
  const variantAttr = tabsVariant(variant);
  const count = (value: number | undefined) =>
    typeof value === 'number' ? <span className="kb-tabs__count">{value}</span> : null;

  if (linkMode) {
    return (
      <nav
        className="kb-tabs"
        data-overflow={overflowAttr}
        data-variant={variantAttr}
        aria-label={tabsLabel}
      >
        {list.map((item) => {
          const href = safeHref(item.href);
          const current = item.id === active ? 'page' : undefined;
          return href ? (
            <KbLink
              key={item.id}
              href={href}
              className="kb-tabs__tab"
              data-tab-id={item.id}
              aria-current={current}
            >
              {item.label}
              {count(item.count)}
            </KbLink>
          ) : (
            <span
              key={item.id}
              className="kb-tabs__tab"
              data-tab-id={item.id}
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
    <div
      className="kb-tabs"
      data-overflow={overflowAttr}
      data-variant={variantAttr}
      role="tablist"
      aria-label={tabsLabel}
    >
      {list.map((item) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            className="kb-tabs__tab"
            data-tab-id={item.id}
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
