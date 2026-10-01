import {
  buildDecisionDigest,
  listAutonomousActionNotices,
  renderDecisionDigestText,
  type DecisionDigest,
  type DigestMissionWait,
} from '@agent/core/governance/approval-digest';
import {
  buildAccountabilityReport,
  renderAccountabilityReportText,
} from '@agent/core/governance/accountability-report';
import {
  listActiveCharters,
  readCharterLedger,
} from '@agent/core/governance/accountability-charter-registry';
import { isFixtureApproval } from '@agent/core/governance/approval-store-hygiene';
import { listApprovalRequests } from '@agent/core/governance/approval-store';
import {
  tickVetoWindows,
  type VetoWindowTickResult,
} from '@agent/core/governance/approval-veto-window';
import { withExecutionContext } from '@agent/core/authority';
import { getAutonomousOpsPolicy } from '@agent/core/governance/autonomous-ops-gate';
import { listMissionsInSearchDirs, loadStateAtPath } from '@agent/core/mission/mission-state';
import { notifyOperatorSync } from '@agent/core/surface/operator-notifications';
import * as path from 'node:path';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

/**
 * Autonomous-operation P1-7 / P1-8: the operator's decision inbox.
 *
 *   node dist/scripts/approval_inbox.js digest [--hours N] [--send] [--json] [--locale en]
 *   node dist/scripts/approval_inbox.js charter [--hours N] [--send] [--json] [--locale en]
 *   node dist/scripts/approval_inbox.js tick [--json]
 *
 * `charter` is the accountable human's report under an accountability charter
 * (one per charter in force): what ran inside it, what is held for a decision,
 * budget use, standing tripwires, and charters about to expire. Schedule it
 * daily with `--send`; with no charter in force it prints nothing to do.
 *
 * `digest` answers "what needs me?" — decisions waiting on the operator, veto
 * windows about to proceed, what the agents did on their own, and waits that
 * have gone quiet. `--send` pushes it through the `decision_digest` route.
 *
 * `tick` advances veto windows: elapsed ones proceed (decided by the policy,
 * recorded as a service), undelivered ones fall back to a human decision.
 * Schedule `tick` every few minutes and `digest --send` morning and evening.
 */

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_DIGEST_HOURS = 12;

function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new ScriptExitError(2, `${flag} requires a value`);
  return value;
}

function readHours(argv: string[]): number {
  const raw = readFlag(argv, '--hours');
  if (raw === undefined) return DEFAULT_DIGEST_HOURS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new ScriptExitError(2, `--hours requires a positive number, got: ${raw}`);
  }
  return hours;
}

export function collectMissionWaits(): DigestMissionWait[] {
  const waits: DigestMissionWait[] = [];
  for (const { missionId, missionPath } of listMissionsInSearchDirs()) {
    const state = loadStateAtPath(path.join(missionPath, 'mission-state.json'));
    const status = String(state?.status ?? '');
    if (status !== 'planned' && status !== 'paused') continue;
    const lastEvent = state?.history?.[state.history.length - 1];
    waits.push({ missionId, status, updatedAt: String(lastEvent?.ts ?? '') });
  }
  return waits;
}

export function collectDecisionDigest(options: { now: number; hours: number }): DecisionDigest {
  const sinceMs = options.now - options.hours * HOUR_MS;
  return withExecutionContext('mission_controller', () =>
    buildDecisionDigest({
      approvals: listApprovalRequests().filter((record) => !isFixtureApproval(record)),
      notices: listAutonomousActionNotices(sinceMs),
      missions: collectMissionWaits(),
      now: options.now,
      since: new Date(sinceMs).toISOString(),
    })
  );
}

function operatorTimezone(): string | undefined {
  try {
    return getAutonomousOpsPolicy().active_hours?.timezone;
  } catch {
    return undefined;
  }
}

export function formatVetoTick(result: VetoWindowTickResult): string {
  const lines = [
    `Veto windows — proceeded: ${result.proceeded.length}, fell back to a decision: ${result.fellBack.length}, shadow elapsed: ${result.shadowElapsed.length}`,
    ...result.proceeded.map((record) => `  proceeded: ${record.title} (${record.id})`),
    ...result.fellBack.map(
      (record) => `  needs decision (undelivered): ${record.title} (${record.id})`
    ),
    ...result.shadowElapsed.map(
      (record) => `  shadow would proceed: ${record.title} (${record.id})`
    ),
  ];
  if (result.errors.length > 0) {
    lines.push(`Errors (${result.errors.length}):`);
    lines.push(...result.errors.map((entry) => `  - ${entry.requestId}: ${entry.error}`));
  }
  return lines.join('\n');
}

function runCharterReport(
  context: { argv: string[]; json: boolean; print: (text: string) => void },
  now: number
) {
  const locale = readFlag(context.argv, '--locale') === 'en' ? 'en' : 'ja';
  const hours = readHours(context.argv);
  const at = new Date(now);
  const send = context.argv.includes('--send');
  const reports = withExecutionContext('mission_controller', () =>
    listActiveCharters(at).map((charter) => {
      const report = buildAccountabilityReport({
        charter,
        ledger: readCharterLedger(charter),
        now: at,
        hours,
      });
      const text = renderAccountabilityReportText(report, { locale });
      let sent = false;
      // An all-clear day is still sent: silence must never be ambiguous
      // between "nothing happened" and "the report broke".
      if (send) {
        sent = notifyOperatorSync(
          report.tripwires_standing.length > 0 ? 'ops_alert' : 'decision_digest',
          {
            title: text.split('\n')[0] ?? 'accountability report',
            body: text.split('\n').slice(1).join('\n'),
            correlation_id: `charter-report:${charter.charter_id}:${at.toISOString().slice(0, 10)}`,
          }
        );
      }
      return { report, text, sent };
    })
  );
  const output =
    reports.length > 0
      ? reports.map((r) => r.text).join('\n\n')
      : 'No accountability charter is in force.';
  context.print(
    context.json
      ? JSON.stringify(
          reports.map((r) => ({ ...r.report, sent: r.sent })),
          null,
          2
        )
      : output
  );
  return reports.map((r) => r.report);
}

export const runApprovalInbox = defineScript({
  name: 'approval-inbox',
  flags: ['json'],
  run(context) {
    const first = context.argv[0];
    const command = first && !first.startsWith('--') ? first : 'digest';
    const now = Date.now();
    if (command === 'tick') {
      const result = withExecutionContext('mission_controller', () =>
        tickVetoWindows('mission_controller', { now })
      );
      context.print(context.json ? JSON.stringify(result, null, 2) : formatVetoTick(result));
      return result;
    }
    if (command === 'charter') return runCharterReport(context, now);
    if (command !== 'digest') {
      throw new ScriptExitError(
        2,
        `Unknown approval-inbox command: ${command} (digest | charter | tick)`
      );
    }
    const digest = collectDecisionDigest({ now, hours: readHours(context.argv) });
    const locale = readFlag(context.argv, '--locale') === 'en' ? 'en' : 'ja';
    const text = renderDecisionDigestText(digest, { locale, timezone: operatorTimezone() });
    let sent = false;
    if (context.argv.includes('--send')) {
      sent = notifyOperatorSync('decision_digest', {
        title: text.split('\n')[0] ?? 'decision digest',
        body: text.split('\n').slice(1).join('\n'),
        correlation_id: `decision-digest:${new Date(now).toISOString().slice(0, 13)}`,
      });
    }
    context.print(context.json ? JSON.stringify({ ...digest, sent }, null, 2) : text);
    return { ...digest, sent };
  },
});

if (
  isDirectScript(import.meta.url, 'approval_inbox.ts') ||
  isDirectScript(import.meta.url, 'approval_inbox.js')
)
  void runApprovalInbox();
