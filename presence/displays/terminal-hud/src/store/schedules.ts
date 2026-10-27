import { listSchedulerIncidents, type SchedulerIncident } from '@agent/core/scheduler-incidents';
import {
  listScheduledPipelines,
  isScheduledPipelineDue,
  type ScheduledPipeline,
} from '@agent/core/pipeline-scheduler';
import { listGenerationSchedules } from '@agent/core/generation-scheduler';
import { pathResolver } from '@agent/core/path-resolver';
import { statusColor, theme } from '../theme.js';
import type { I18n } from '../i18n.js';
import type { PanelViewModel } from './types.js';

export interface SchedulesData {
  schedules: Array<ScheduledPipeline & { due: boolean }>;
  generationLines: string[];
  incidents?: SchedulerIncident[];
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
  const incidents = listSchedulerIncidents().filter((incident) =>
    schedules.some((schedule) => schedule.id === incident.scheduleId)
  );
  return { schedules, generationLines, incidents };
}

export function schedulesWatchPaths(): string[] {
  return [
    pathResolver.active('shared/runtime/pipeline-schedules.json'),
    pathResolver.shared('observability/ops-alerts.jsonl'),
  ];
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
    sections: [
      ...(data.generationLines.length
        ? [{ title: 'media-generation', lines: data.generationLines }]
        : []),
      ...((data.incidents || []).length
        ? [
            {
              title: i18n.tr('tui:tui_schedule_incidents'),
              lines: data.incidents!.slice(0, 8).flatMap((incident) => [
                `${incident.scheduleId} · ${incident.cause} · ${incident.resolvedBy === 'superseded' ? i18n.tr('tui:tui_incident_superseded') : incident.resolvedBy === 'recovered' ? i18n.tr('tui:tui_incident_recovered') : incident.status} · ${incident.occurrences} · ${incident.lastSeenAt}`,
                ...(incident.status === 'detected' && incident.episodeId
                  ? [
                      i18n.tr('tui:tui_incident_ack_hint', {
                        id: incident.scheduleId,
                        signature: incident.signature,
                        episode: incident.episodeId,
                      }),
                    ]
                  : []),
              ]),
            },
          ]
        : []),
    ],
  };
}
