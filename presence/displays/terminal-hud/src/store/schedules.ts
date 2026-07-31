import {
  listScheduledPipelines,
  isScheduledPipelineDue,
  listGenerationSchedules,
  pathResolver,
  type ScheduledPipeline,
} from '@agent/core';
import { statusColor, theme } from '../theme.js';
import type { I18n } from '../i18n.js';
import type { PanelViewModel } from './types.js';

export interface SchedulesData {
  schedules: Array<ScheduledPipeline & { due: boolean }>;
  generationLines: string[];
}

export function loadSchedules(): SchedulesData {
  const schedules = listScheduledPipelines().map((schedule: ScheduledPipeline) => {
    let due = false;
    try {
      due = isScheduledPipelineDue(schedule);
    } catch {
      // invalid cron expressions are surfaced via the enabled/lastStatus columns
    }
    return { ...schedule, due };
  });
  let generationLines: string[] = [];
  try {
    generationLines = listGenerationSchedules()
      .slice(0, 5)
      .map((entry: any) => [entry.id ?? '?', entry.status ?? '', entry.cron ?? ''].join('  '));
  } catch {
    // media generation schedules are optional context
  }
  return { schedules, generationLines };
}

export function schedulesWatchPaths(): string[] {
  return [pathResolver.active('shared/runtime/pipeline-schedules.json')];
}

export function schedulesViewModel(data: SchedulesData, i18n: I18n): PanelViewModel {
  return {
    columns: [
      'ID',
      'cron',
      'enabled',
      i18n.tr('tui:tui_schedule_last_run'),
      i18n.tr('tui:tui_schedule_due'),
    ],
    rows: data.schedules.map((schedule) => ({
      id: schedule.id,
      color: schedule.due
        ? theme.warn
        : schedule.enabled
          ? statusColor(schedule.lastStatus ?? 'ready')
          : theme.dim,
      cells: [
        schedule.id,
        schedule.trigger.cron ??
          (schedule.trigger.intervalMs ? `${schedule.trigger.intervalMs}ms` : '-'),
        schedule.enabled ? 'on' : 'off',
        `${schedule.lastRun ?? '-'} ${schedule.lastStatus ?? ''}`.trim(),
        schedule.due ? '●' : '',
      ],
      detail: [
        { label: 'name', value: schedule.name },
        { label: 'pipeline', value: schedule.pipelinePath },
        { label: 'actuator', value: schedule.actuator },
        { label: 'timezone', value: schedule.trigger.timezone ?? '-' },
        {
          label: 'deliver_to',
          value: schedule.deliver_to
            ? `${schedule.deliver_to.surface}#${schedule.deliver_to.channel}`
            : '-',
        },
      ],
    })),
    sections:
      data.generationLines.length > 0
        ? [{ title: 'media-generation', lines: data.generationLines }]
        : undefined,
  };
}
