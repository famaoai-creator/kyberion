/**
 * Daily reminder sweep for meeting-derived action items.
 *
 * Enumerates active missions, drafts reminder text for every pending
 * team-member item, appends the reminder to the mission store, and
 * mirrors the reminder into the Slack outbox for operator visibility.
 */

import { runActionItemReminderSweepOp } from '../libs/actuators/meeting-actuator/src/meeting-intelligence-ops.js';
import { defineScript, isDirectScript } from './lib/harness.js';

export const runActionItemReminderSweep = runActionItemReminderSweepOp;

async function main(argv: string[]): Promise<void> {
  const getArgValue = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
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

if (
  isDirectScript(import.meta.url, 'action_item_reminders.ts') ||
  isDirectScript(import.meta.url, 'action_item_reminders.js')
)
  void defineScript({
    name: 'action-item-reminders',
    flags: [],
    run(context) {
      return main(context.argv);
    },
  })();
