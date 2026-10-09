'use client';

import { frontDeskFetch as fetch } from '../lib/front-desk-fetch';

import * as React from 'react';
import { useConciergeI18n } from '../lib/use-concierge-i18n';
import { frontDeskText, type FrontDeskMessageKey } from '../lib/i18n';
import {
  TENANT_CHANGED_EVENT,
  readSelectedTenant,
  withSelectedTenant,
} from '../lib/tenant-context';

/** The rail and palette share the server's role-gated, manifest-resolved catalog. */
type PaletteEntry = {
  id: string;
  label: string;
  sublabel?: string;
  group_label?: string;
  icon?: string;
  scope_query_style?: 'snake' | 'camel';
  href?: string;
  event?: string;
};
type NavItem = PaletteEntry & { allowed: boolean; href: string };

const SETTINGS_SHORTCUTS: Array<{ anchor: string; labelKey: FrontDeskMessageKey }> = [
  { anchor: 'setup-profile', labelKey: 'settings_nav_profile' },
  { anchor: 'settings-display', labelKey: 'settings_nav_display' },
  { anchor: 'settings-members', labelKey: 'settings_nav_members' },
  { anchor: 'setup-services', labelKey: 'settings_nav_services' },
  { anchor: 'setup-media', labelKey: 'settings_nav_voice' },
  { anchor: 'setup-notifications', labelKey: 'settings_nav_notifications' },
  { anchor: 'settings-recording', labelKey: 'settings_nav_recording' },
  { anchor: 'setup-plugins', labelKey: 'settings_nav_plugins' },
  { anchor: 'settings-advanced', labelKey: 'settings_nav_advanced' },
];

function allowedItems(payload: unknown): NavItem[] {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('items' in payload) ||
    !Array.isArray(payload.items)
  )
    return [];
  return payload.items.filter(
    (item): item is NavItem =>
      !!item &&
      item.allowed === true &&
      typeof item.id === 'string' &&
      typeof item.label === 'string' &&
      typeof item.href === 'string'
  );
}

export function CommandPalette() {
  const { locale, t } = useConciergeI18n();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [tenant, setTenant] = React.useState<string | null>(null);
  const [catalog, setCatalog] = React.useState<{
    locale: string;
    tenant: string | null;
    items: NavItem[];
  } | null>(null);
  const generation = React.useRef(0);
  const openRef = React.useRef(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const listRef = React.useRef<HTMLUListElement | null>(null);
  const previousFocus = React.useRef<HTMLElement | null>(null);

  const close = React.useCallback(() => {
    openRef.current = false;
    generation.current += 1;
    setCatalog(null);
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
    previousFocus.current?.focus();
  }, []);

  React.useEffect(() => {
    const refreshTenant = () => {
      if (readSelectedTenant() === tenant) return;
      generation.current += 1;
      setCatalog(null);
      setTenant(readSelectedTenant());
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (openRef.current) {
          close();
          return;
        }
        previousFocus.current = document.activeElement as HTMLElement | null;
        refreshTenant();
        openRef.current = true;
        setOpen(true);
        setQuery('');
        setActiveIndex(0);
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'front-desk.tenant' || event.key === null) refreshTenant();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(TENANT_CHANGED_EVENT, refreshTenant);
    window.addEventListener('popstate', refreshTenant);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(TENANT_CHANGED_EVENT, refreshTenant);
      window.removeEventListener('popstate', refreshTenant);
      window.removeEventListener('storage', onStorage);
    };
  }, [close, tenant]);

  React.useEffect(() => {
    if (!open) return;
    const request = ++generation.current;
    const controller = new AbortController();
    setCatalog(null);
    fetch(withSelectedTenant('/api/front-desk/nav?locale=' + locale, tenant), {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        if (
          controller.signal.aborted ||
          request !== generation.current ||
          !openRef.current ||
          tenant !== readSelectedTenant()
        )
          return;
        setCatalog({ locale, tenant, items: allowedItems(payload) });
      })
      .catch(() => {
        if (!controller.signal.aborted && request === generation.current) setCatalog(null);
      });
    return () => controller.abort();
  }, [open, locale, tenant]);

  const entries = React.useMemo(() => {
    const nav = catalog?.locale === locale && catalog.tenant === tenant ? catalog.items : [];
    const settings = nav.find((item) => item.id === 'settings');
    const shortcuts: PaletteEntry[] = settings
      ? SETTINGS_SHORTCUTS.map(({ anchor, labelKey }) => ({
          id: anchor,
          label: frontDeskText(labelKey, locale),
          href: settings.href.split('#')[0] + '#' + anchor,
        }))
      : [];
    const all: PaletteEntry[] = [
      { id: 'dock', label: t('palette.dock'), event: 'concierge:open-dock' },
      ...nav.map((item) => ({ ...item, id: 'front-desk-' + item.id })),
      ...shortcuts,
    ];
    const needle = query.trim().toLowerCase();
    return all
      .filter((entry) =>
        [entry.label, entry.sublabel, entry.group_label].some(
          (text) => typeof text === 'string' && text.toLowerCase().includes(needle)
        )
      )
      .map((entry) => ({ entry, label: entry.label }));
  }, [catalog, locale, tenant, query, t]);

  const run = React.useCallback(
    (entry: PaletteEntry) => {
      // A selection made before React processes a tenant event must not use old grants.
      if (entry.href && tenant !== readSelectedTenant()) {
        close();
        return;
      }
      close();
      if (entry.event) window.dispatchEvent(new CustomEvent(entry.event));
      else if (entry.href) {
        // Native navigation updates history and emits hashchange, allowing Settings
        // to reveal collapsed sections and supporting browser Back/Forward.
        const target = withSelectedTenant(entry.href, tenant, entry.scope_query_style);
        if (
          new URL(target, window.location.href).href === window.location.href &&
          window.location.hash
        ) {
          window.dispatchEvent(new Event('hashchange'));
        } else window.location.href = target;
      }
    },
    [close, tenant]
  );

  React.useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const clampedIndex = Math.min(activeIndex, Math.max(entries.length - 1, 0));

  return (
    <div
      className="palette-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        onKeyDown={(event) => {
          // Focus stays inside: the input is the only tabbable element and
          // Tab is repurposed as list navigation, so the dialog is its own trap.
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          } else if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
            event.preventDefault();
            setActiveIndex((prev) => (entries.length ? (prev + 1) % entries.length : 0));
          } else if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
            event.preventDefault();
            setActiveIndex((prev) =>
              entries.length ? (prev - 1 + entries.length) % entries.length : 0
            );
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const chosen = entries[clampedIndex];
            if (chosen) run(chosen.entry);
          }
        }}
      >
        <input
          ref={inputRef}
          type="text"
          className="palette-input"
          value={query}
          placeholder={t('palette.placeholder')}
          aria-label={t('palette.placeholder')}
          aria-activedescendant={
            entries[clampedIndex] ? `palette-item-${entries[clampedIndex].entry.id}` : undefined
          }
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
        />
        <ul className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {entries.length === 0 ? (
            <li className="palette-empty">{t('palette.empty')}</li>
          ) : (
            entries.map(({ entry, label }, index) => (
              <li key={entry.id} role="presentation">
                <button
                  type="button"
                  id={`palette-item-${entry.id}`}
                  role="option"
                  aria-selected={index === clampedIndex}
                  className={`palette-item${index === clampedIndex ? ' active' : ''}`}
                  tabIndex={-1}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => run(entry)}
                >
                  {label}
                </button>
              </li>
            ))
          )}
        </ul>
        <p className="palette-hint">{t('palette.hint')}</p>
      </div>
    </div>
  );
}
