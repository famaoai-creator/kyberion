/**
 * Daily reminder sweep for meeting-derived action items.
 *
 * Enumerates active missions, drafts reminder text for every pending
 * team-member item, appends the reminder to the mission store, and
 * mirrors the reminder into the Slack outbox for operator visibility.
 */

import {
  appendReminder,
  enqueueSlackOutboxMessage,
  listOthersPending,
  listSlackOutboxMessages,
  pathResolver,
  safeWriteFile,
} from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMissionSummaries } from './refactor/mission-read-model.js';
import { generateReminderMessageOp } from '../libs/actuators/wisdom-actuator/src/decision-ops.js';

export interface ActionItemReminderSweepReport {
  generated_at: string;
  missions_scanned: number;
  missions_with_pending_items: number;
  reminders_sent: number;
  outbox_messages_sent: number;
  outbox_message_ids: string[];
  missions: Array<{
    mission_id: string;
    pending_items: number;
    reminders_sent: number;
    outbox_messages_sent: number;
    outbox_message_ids: string[];
  }>;
}

export async function runActionItemReminderSweep(input?: {
  mission_ids?: string[];
  tone?: 'friendly' | 'formal' | 'urgent';
  language?: string;
  max_items_per_mission?: number;
  report_path?: string;
}): Promise<ActionItemReminderSweepReport> {
  const tone = input?.tone ?? 'friendly';
  const language = input?.language ?? 'ja';
  const maxItemsPerMission = input?.max_items_per_mission ?? 20;
  const now = new Date();
  const sweepDayKey = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const sweepSentAt = `${sweepDayKey}T00:00:00.000Z`;
  const existingOutbox = new Set(
    listSlackOutboxMessages()
      .filter((message) => typeof message.correlation_id === 'string')
      .map((message) => message.correlation_id as string)
  );
  const missions = listMissionSummaries('active').filter((mission) =>
    input?.mission_ids?.length ? input.mission_ids.includes(mission.id) : true
  );
  const report: ActionItemReminderSweepReport = {
    generated_at: new Date().toISOString(),
    missions_scanned: missions.length,
    missions_with_pending_items: 0,
    reminders_sent: 0,
    outbox_messages_sent: 0,
    outbox_message_ids: [],
    missions: [],
  };

  for (const mission of missions) {
    const pending = listOthersPending(mission.id)
      .map((item) => ({
        item,
        days_overdue: computeDaysOverdue(item.due_at, now),
      }))
      .sort((a, b) => {
        if (a.days_overdue !== b.days_overdue) return b.days_overdue - a.days_overdue;
        const aDue = itemSortTimestamp(a.item.due_at) ?? itemSortTimestamp(a.item.created_at);
        const bDue = itemSortTimestamp(b.item.due_at) ?? itemSortTimestamp(b.item.created_at);
        if (aDue !== bDue) return aDue - bDue;
        if (a.item.priority !== b.item.priority) {
          return priorityRank(b.item.priority) - priorityRank(a.item.priority);
        }
        return a.item.item_id.localeCompare(b.item.item_id);
      })
      .slice(0, maxItemsPerMission)
      .map((entry) => entry.item);
    if (pending.length === 0) continue;

    report.missions_with_pending_items += 1;
    let remindersSent = 0;
    let outboxMessagesSent = 0;
    const outboxMessageIds: string[] = [];

    for (const item of pending) {
      const daysOverdue = computeDaysOverdue(item.due_at, now);
      const reminder = await generateReminderMessageOp({
        item,
        days_overdue: daysOverdue,
        tone,
        language,
      });
      const primaryCorrelationId = `${mission.id}:${item.item_id}:${sweepDayKey}`;
      const primaryAlreadyRecorded = item.reminders?.some(
        (record) => record.sent_at === sweepSentAt && record.channel === reminder.channel
      );
      if (!primaryAlreadyRecorded) {
        appendReminder({
          mission_id: mission.id,
          item_id: item.item_id,
          reminder: {
            sent_at: sweepSentAt,
            channel: reminder.channel,
            message: reminder.text,
            relationship: 'primary',
          },
        });
        remindersSent += 1;
      }
      if (reminder.cc?.length) {
        for (const ccChannel of reminder.cc) {
          const ccAlreadyRecorded = item.reminders?.some(
            (record) => record.sent_at === sweepSentAt && record.channel === ccChannel
          );
          if (ccAlreadyRecorded) continue;
          appendReminder({
            mission_id: mission.id,
            item_id: item.item_id,
            reminder: {
              sent_at: sweepSentAt,
              channel: ccChannel,
              message: reminder.text,
              relationship: 'cc_manager',
            },
          });
          remindersSent += 1;
        }
      }
      if (!existingOutbox.has(primaryCorrelationId)) {
        const outboxMessageId = enqueueSlackOutboxMessage({
          correlationId: primaryCorrelationId,
          channel: reminder.channel,
          threadTs: item.item_id,
          text: [
            `Mission ${mission.id}`,
            `Item ${item.item_id}: ${item.title}`,
            reminder.text,
          ].join('\n'),
          source: 'system',
        });
        existingOutbox.add(primaryCorrelationId);
        outboxMessagesSent += 1;
        outboxMessageIds.push(outboxMessageId);
        report.outbox_message_ids.push(outboxMessageId);
      }
    }

    report.reminders_sent += remindersSent;
    report.outbox_messages_sent += outboxMessagesSent;
    report.missions.push({
      mission_id: mission.id,
      pending_items: pending.length,
      reminders_sent: remindersSent,
      outbox_messages_sent: outboxMessagesSent,
      outbox_message_ids: outboxMessageIds,
    });
  }

  const defaultReportPath = pathResolver.rootResolve(
    'active/shared/tmp/action-item-reminders-report.json'
  );
  const reportPath = input?.report_path
    ? pathResolver.rootResolve(input.report_path)
    : defaultReportPath;
  safeWriteFile(reportPath, JSON.stringify(report, null, 2));
  return report;
}

function priorityRank(priority?: 'must' | 'should' | 'could' | 'wont'): number {
  switch (priority) {
    case 'must':
      return 3;
    case 'should':
      return 2;
    case 'could':
      return 1;
    case 'wont':
    default:
      return 0;
  }
}

function itemSortTimestamp(value?: string): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function computeDaysOverdue(dueAt?: string, now = new Date()): number {
  if (!dueAt) return 0;
  const parsed = Date.parse(dueAt);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor((now.getTime() - parsed) / (24 * 60 * 60 * 1000)));
}

async function main(): Promise<void> {
  const getArgValue = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const toneValue = getArgValue('--tone');
  const languageValue = getArgValue('--language');
  const reportPathValue = getArgValue('--report-path');
  const maxItemsValue = Number(getArgValue('--max-items') || '20');
  const report = await runActionItemReminderSweep({
    tone: toneValue === 'formal' || toneValue === 'urgent' ? toneValue : 'friendly',
    language: languageValue === 'en' ? 'en' : 'ja',
    max_items_per_mission: Number.isFinite(maxItemsValue) && maxItemsValue > 0 ? maxItemsValue : 20,
    ...(reportPathValue ? { report_path: reportPathValue } : {}),
  });
  console.log(JSON.stringify(report, null, 2));
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
