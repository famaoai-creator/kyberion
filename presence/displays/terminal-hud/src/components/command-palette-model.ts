import { PANELS, PANEL_LABEL_KEYS, type PanelId } from '../keymap.js';
import type { I18n } from '../i18n.js';

export type PaletteSelection =
  { kind: 'panel'; panel: PanelId } | { kind: 'refresh' | 'help' | 'connections' };

export interface PaletteEntry {
  id: string;
  category: string;
  label: string;
  keywords: string;
  selection: PaletteSelection;
}

/** Discovery only: the picker never dispatches a shell command or a mutation. */
export function navigationPalette(i18n: I18n): PaletteEntry[] {
  return [
    ...PANELS.map((panel) => ({
      id: `panel:${panel}`,
      category: i18n.tr('tui:tui_palette_navigation'),
      label: i18n.tr(PANEL_LABEL_KEYS[panel]),
      keywords: panel,
      selection: { kind: 'panel' as const, panel },
    })),
    {
      id: 'connections',
      category: i18n.tr('tui:tui_palette_actions'),
      label: i18n.tr('tui:tui_connections'),
      keywords: 'connectors connections accounts services credentials concierge',
      selection: { kind: 'connections' as const },
    },
    {
      id: 'refresh',
      category: i18n.tr('tui:tui_palette_actions'),
      label: i18n.tr('tui:tui_key_refresh'),
      keywords: 'refresh reload',
      selection: { kind: 'refresh' as const },
    },
    {
      id: 'help',
      category: i18n.tr('tui:tui_palette_actions'),
      label: i18n.tr('tui:tui_help_title'),
      keywords: 'help shortcuts commands',
      selection: { kind: 'help' as const },
    },
  ];
}

export function filterPalette(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const terms = query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  return entries.filter((entry) => {
    const searchable = `${entry.category} ${entry.label} ${entry.keywords}`
      .normalize('NFKC')
      .toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}
