import { t } from '@agent/core/t';
import { PANELS, PANEL_LABEL_KEYS, isPanelId, type PanelId } from './keymap.js';
import { defaultLocale, makeI18n, type I18n } from './i18n.js';
import type { PanelViewModel } from './store/types.js';
import { loadMissions, missionsViewModel } from './store/missions.js';
import { loadWork, workViewModel } from './store/work.js';
import { loadSchedules, schedulesViewModel } from './store/schedules.js';
import { loadProcesses, processesViewModel } from './store/processes.js';
import { loadCoordination, coordinationViewModel } from './store/coordination.js';
import { loadStats, statsViewModel } from './store/stats.js';
import { loadProfile, profileViewModel } from './store/profile.js';
import { loadSettings, settingsViewModel } from './store/settings.js';
import { loadAgentGraph, agentGraphViewModel } from './store/agent-graph.js';

export interface SnapshotOptions {
  panel?: string;
}

const SNAPSHOT_LOADERS: Record<PanelId, (i18n: I18n) => Promise<PanelViewModel>> = {
  missions: async (i18n) => missionsViewModel(loadMissions(), i18n),
  tasks: async (i18n) => workViewModel(loadWork(), i18n),
  schedules: async (i18n) => schedulesViewModel(loadSchedules(), i18n),
  processes: async (i18n) => processesViewModel(loadProcesses(), i18n),
  coordination: async (i18n) => coordinationViewModel(await loadCoordination(), i18n),
  stats: async (i18n) => statsViewModel(loadStats(), i18n),
  profile: async (i18n) => profileViewModel(loadProfile(), i18n),
  settings: async (i18n) => settingsViewModel(loadSettings(), i18n),
  agents: async (i18n) => agentGraphViewModel(await loadAgentGraph(), i18n),
};

const MAX_SNAPSHOT_ROWS = 15;

function formatViewModel(vm: PanelViewModel): string[] {
  const lines: string[] = [];
  if (vm.columns && (vm.rows?.length ?? 0) > 0) {
    lines.push(vm.columns.join(' | '));
    for (const row of (vm.rows ?? []).slice(0, MAX_SNAPSHOT_ROWS)) {
      lines.push(row.cells.join(' | '));
    }
    const hidden = (vm.rows?.length ?? 0) - MAX_SNAPSHOT_ROWS;
    if (hidden > 0) lines.push(`… +${hidden}`);
  }
  for (const section of vm.sections ?? []) {
    if (section.title) lines.push(`# ${section.title}`);
    lines.push(...section.lines);
  }
  return lines;
}

export async function renderSnapshotLines(options: SnapshotOptions = {}): Promise<string[]> {
  const focus: PanelId | undefined =
    options.panel && isPanelId(options.panel) ? options.panel : undefined;
  const panels = focus ? [focus] : [...PANELS];
  const i18n = makeI18n(defaultLocale());
  const lines: string[] = ['Kyberion Terminal HUD'];
  for (const panel of panels) {
    lines.push('', `## ${t(PANEL_LABEL_KEYS[panel])}`);
    try {
      const vm = await SNAPSHOT_LOADERS[panel](i18n);
      const body = formatViewModel(vm);
      lines.push(...(body.length > 0 ? body : [i18n.tr('tui:tui_empty')]));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      lines.push(`${i18n.tr('tui:tui_error')}: ${message}`);
    }
  }
  return lines;
}
