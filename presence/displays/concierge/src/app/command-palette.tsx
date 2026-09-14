'use client';

import * as React from 'react';
import { useConciergeI18n } from '../lib/use-concierge-i18n';
import { frontDeskText, type ConciergeMessageKey, type FrontDeskMessageKey } from '../lib/i18n';
// Type-only: erased at compile time (`isolatedModules`), so it never pulls
// `@agent/core/front-desk-nav`'s Node-only runtime (`surface-runtime` /
// `secure-io`) into this client bundle. See the `frontDeskPorts` prop below.
import type { FrontDeskSurfacePorts } from '@agent/core/front-desk-nav';

/**
 * CS-04 command palette — ⌘K / Ctrl+K opens a small, keyboard-first overlay
 * for reaching every concierge destination without hunting through the
 * navigation. Pure navigation + opening the conversation dock; it never
 * performs a decision itself (those stay behind their guarded, confirmed
 * flows) and never fetches — every entry resolves synchronously so the
 * palette opens instantly.
 *
 * FD-00c: also exposes the 5 shared front-desk rail items (home / ask /
 * decide / progress / settings). The concierge-hosted two (decide /
 * settings) use relative hrefs; the other three's cross-surface hrefs are
 * built from `frontDeskPorts` — the manifest-resolved ports, read once by
 * `layout.tsx` (a Server Component) via `readFrontDeskSurfacePorts()` and
 * passed down as a plain prop, since `@agent/core/front-desk-nav`'s runtime
 * exports cannot be imported into this client component (that module pulls
 * in `surface-runtime`/`secure-io`, which reference Node-only `node:fs`,
 * `node:child_process`, … and cannot be bundled for the browser). No port
 * is ever hardcoded here. Role gating is left to the destination route
 * (same defense-in-depth already used by the unconditional `setup`/`ingest`
 * entries below); the palette is a navigation aid, not an authorization
 * surface.
 */

type PaletteEntry = {
  id: string;
  labelKey?: ConciergeMessageKey;
  /** Pre-resolved label (used for the front-desk rail entries below). */
  label?: string;
  /** Either a navigation target… */
  href?: string;
  /** …or a same-page action (open the conversation dock). */
  event?: string;
};

const PALETTE_ENTRIES: PaletteEntry[] = [
  { id: 'home', labelKey: 'palette.home', href: '/' },
  { id: 'dock', labelKey: 'palette.dock', event: 'concierge:open-dock' },
  { id: 'ingest', labelKey: 'palette.ingest', href: '/ingest' },
  { id: 'setup', labelKey: 'palette.setup', href: '/settings' },
  { id: 'setup-profile', labelKey: 'palette.setup_profile', href: '/settings#setup-profile' },
  { id: 'setup-services', labelKey: 'palette.setup_services', href: '/settings#setup-services' },
  {
    id: 'setup-notifications',
    labelKey: 'palette.setup_notifications',
    href: '/settings#setup-notifications',
  },
  { id: 'setup-plugins', labelKey: 'palette.setup_plugins', href: '/settings#setup-plugins' },
  {
    id: 'setup-governance',
    labelKey: 'palette.setup_governance',
    href: '/settings#setup-governance',
  },
];

export interface CommandPaletteProps {
  /** Manifest-resolved surface ports, read server-side by `layout.tsx`. */
  frontDeskPorts: FrontDeskSurfacePorts;
}

export function CommandPalette({ frontDeskPorts }: CommandPaletteProps) {
  const { locale, t } = useConciergeI18n();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const listRef = React.useRef<HTMLUListElement | null>(null);

  const frontDeskEntries = React.useMemo<PaletteEntry[]>(() => {
    const presenceStudioPort = frontDeskPorts['presence-studio'];
    const items: Array<{ id: string; labelKey: FrontDeskMessageKey; href: string }> = [
      { id: 'home', labelKey: 'nav_home', href: `http://127.0.0.1:${presenceStudioPort}/` },
      { id: 'ask', labelKey: 'nav_ask', href: `http://127.0.0.1:${presenceStudioPort}/ask` },
      { id: 'decide', labelKey: 'nav_decide', href: '/' },
      {
        id: 'progress',
        labelKey: 'nav_progress',
        href: `http://127.0.0.1:${presenceStudioPort}/progress`,
      },
      { id: 'settings', labelKey: 'nav_settings', href: '/settings' },
    ];
    return items.map((item) => ({
      id: `front-desk-${item.id}`,
      label: frontDeskText(item.labelKey, locale),
      href: item.href,
    }));
  }, [frontDeskPorts, locale]);

  const entries = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const labeled = [...PALETTE_ENTRIES, ...frontDeskEntries].map((entry) => ({
      entry,
      label: entry.label ?? t(entry.labelKey as ConciergeMessageKey),
    }));
    if (!needle) return labeled;
    return labeled.filter(({ label }) => label.toLowerCase().includes(needle));
  }, [query, t, frontDeskEntries]);

  const close = React.useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  }, []);

  const run = React.useCallback(
    (entry: PaletteEntry) => {
      close();
      if (entry.event) {
        window.dispatchEvent(new CustomEvent(entry.event));
        return;
      }
      if (entry.href) {
        // Same-page hash targets scroll smoothly unless reduced motion is on.
        const [path, hash] = entry.href.split('#');
        if (hash && window.location.pathname === path) {
          const target = document.getElementById(hash);
          if (target) {
            const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
            return;
          }
        }
        window.location.href = entry.href;
      }
    },
    [close]
  );

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((prev) => !prev);
        setQuery('');
        setActiveIndex(0);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
