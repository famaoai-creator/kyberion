import type { VocabularyKey } from '@agent/core/t';

export const PANELS = [
  'missions',
  'tasks',
  'schedules',
  'processes',
  'coordination',
  'stats',
  'profile',
  'settings',
] as const;

export type PanelId = (typeof PANELS)[number];

export const PANEL_LABEL_KEYS: Record<PanelId, VocabularyKey> = {
  missions: 'tui:tui_tab_missions',
  tasks: 'tui:tui_tab_tasks',
  schedules: 'tui:tui_tab_schedules',
  processes: 'tui:tui_tab_processes',
  coordination: 'tui:tui_tab_coordination',
  stats: 'tui:tui_tab_stats',
  profile: 'tui:tui_tab_profile',
  settings: 'tui:tui_tab_settings',
};

export interface HelpRow {
  keys: string;
  labelKey: VocabularyKey;
}

export const GLOBAL_HELP: HelpRow[] = [
  { keys: '1-8', labelKey: 'tui:tui_key_switch_panel' },
  { keys: '[ / ]', labelKey: 'tui:tui_key_cycle' },
  { keys: 'j / k', labelKey: 'tui:tui_key_move' },
  { keys: 'Enter', labelKey: 'tui:tui_key_detail' },
  { keys: 'r', labelKey: 'tui:tui_key_refresh' },
  { keys: 'i', labelKey: 'tui:tui_key_input' },
  { keys: ':', labelKey: 'tui:tui_key_palette' },
  { keys: 'v', labelKey: 'tui:tui_key_voice' },
  { keys: '?', labelKey: 'tui:tui_key_help' },
  { keys: 'q', labelKey: 'tui:tui_key_quit' },
  { keys: 'Esc', labelKey: 'tui:tui_key_close' },
];

export function panelForDigit(input: string): PanelId | undefined {
  const idx = Number.parseInt(input, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= PANELS.length) return undefined;
  return PANELS[idx];
}

export function nextPanel(current: PanelId, direction: 1 | -1): PanelId {
  const idx = PANELS.indexOf(current);
  return PANELS[(idx + direction + PANELS.length) % PANELS.length];
}

export function isPanelId(value: string): value is PanelId {
  return (PANELS as readonly string[]).includes(value);
}
