'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  A2UIActionProvider,
  AppShell,
  DisplayControls,
  KB_DISPLAY_CONTROLS_ACTIONS,
  KbI18nProvider,
  NavRail,
  PageHeader,
  useA2UIActions,
  type A2UILinkProps,
} from '@agent/shared-ui';
import type { OperatorLocale } from '../lib/i18n';
import {
  hasLocaleCookie,
  normalizeThemePreference,
  readStoredLocale,
  readThemePreference,
  storeLocalePreference,
  storeThemePreference,
  type OperatorThemePreference,
} from '../lib/display-preferences';

/**
 * UI-08 — the 監査モニタ shell: `ui:app-shell` (compact density, operator
 * role) with a `ui:nav-rail` (brand, tenant context, sections) and the
 * providers every page shares: the shared-ui locale + `ui:*` bundle, and
 * `next/link` / router navigation for kb links and clickable table rows.
 * All copy arrives already translated from the server layout; this file only
 * holds the viewer's display preferences (theme, language).
 */

export interface OperatorNavItem {
  id: string;
  label: string;
  href: string;
  icon: string;
}

export interface OperatorShellProps {
  locale: OperatorLocale;
  messages: Readonly<Record<string, string>>;
  navLabel: string;
  brand: { name: string; subtitle: string };
  context: { label: string; detail: string };
  items: OperatorNavItem[];
  roleBadge: string;
  children?: React.ReactNode;
}

interface OperatorDisplayContextValue {
  locale: OperatorLocale;
  theme: OperatorThemePreference;
  roleBadge: string;
  setTheme: (theme: OperatorThemePreference) => void;
  setLocale: (locale: OperatorLocale) => void;
}

const OperatorDisplayContext = React.createContext<OperatorDisplayContextValue | null>(null);

function NextKbLink({ href, children, ...rest }: A2UILinkProps) {
  return (
    <Link href={href} {...rest}>
      {children}
    </Link>
  );
}

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/' || pathname.startsWith('/missions');
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function OperatorShell({
  locale,
  messages,
  navLabel,
  brand,
  context,
  items,
  roleBadge,
  children,
}: OperatorShellProps) {
  const router = useRouter();
  const pathname = usePathname() || '/';
  const [theme, setThemeState] = React.useState<OperatorThemePreference>('system');

  React.useEffect(() => {
    setThemeState(readThemePreference());
    // A language chosen on this port before the shared cookie existed:
    // mirror it into the cookie so the server renders in that language.
    const stored = readStoredLocale();
    if (stored && stored !== locale && !hasLocaleCookie()) {
      storeLocalePreference(stored);
      router.refresh();
    }
    // Only on first mount; later changes go through setLocale.
  }, []);

  React.useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setTheme = React.useCallback((next: OperatorThemePreference) => {
    setThemeState(next);
    storeThemePreference(next);
  }, []);

  const setLocale = React.useCallback(
    (next: OperatorLocale) => {
      storeLocalePreference(next);
      router.refresh();
    },
    [router]
  );

  const navigate = React.useCallback((href: string) => router.push(href), [router]);

  const display = React.useMemo(
    () => ({ locale, theme, roleBadge, setTheme, setLocale }),
    [locale, theme, roleBadge, setTheme, setLocale]
  );

  return (
    <OperatorDisplayContext.Provider value={display}>
      <KbI18nProvider locale={locale} messages={messages}>
        <A2UIActionProvider linkComponent={NextKbLink} navigate={navigate}>
          <AppShell
            density="compact"
            role="operator-surface"
            nav={
              <NavRail
                label={navLabel}
                brand={brand}
                context={context}
                items={items.map((item) => ({ ...item, active: isActive(pathname, item.href) }))}
              />
            }
          >
            <div className="operator-column">{children}</div>
          </AppShell>
        </A2UIActionProvider>
      </KbI18nProvider>
    </OperatorDisplayContext.Provider>
  );
}

/**
 * `ui:page-header` for one page: page title + description, the read-only
 * role badge (監査モニタ · 読み取り専用) and the shared display controls.
 */
export function OperatorPageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  const display = React.useContext(OperatorDisplayContext);
  const outer = useA2UIActions();
  const setTheme = display?.setTheme;
  const setLocale = display?.setLocale;
  const onAction = React.useCallback(
    (actionId: string, payload?: Record<string, unknown>) => {
      if (actionId === KB_DISPLAY_CONTROLS_ACTIONS.theme) {
        setTheme?.(normalizeThemePreference(payload?.value));
      } else if (actionId === KB_DISPLAY_CONTROLS_ACTIONS.locale) {
        setLocale?.(payload?.value === 'en' ? 'en' : 'ja');
      }
    },
    [setTheme, setLocale]
  );
  return (
    <A2UIActionProvider
      onAction={onAction}
      linkComponent={outer.linkComponent}
      navigate={outer.navigate}
    >
      <PageHeader
        title={title}
        subtitle={subtitle}
        role_badge={display ? { label: display.roleBadge, role: 'operator-surface' } : undefined}
      >
        <DisplayControls
          id="display-controls"
          theme={display?.theme ?? 'system'}
          locale={display?.locale ?? 'ja'}
        />
      </PageHeader>
    </A2UIActionProvider>
  );
}
