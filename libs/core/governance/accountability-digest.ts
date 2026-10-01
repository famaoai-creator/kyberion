/**
 * Build (and optionally deliver) the accountable human's report for every
 * charter in force. Shared by `approval_inbox charter` and the scheduled
 * `core:accountability_report` pipeline op so both behave identically.
 */

import { withExecutionContext } from '../authority.js';
import { notifyOperatorSync } from '../surface/operator-notifications.js';
import {
  buildAccountabilityReport,
  renderAccountabilityReportText,
  type AccountabilityReport,
} from './accountability-report.js';
import {
  listActiveCharters,
  readCharterLedger,
  type CharterPathOptions,
} from './accountability-charter-registry.js';

export interface AccountabilityDigestEntry {
  report: AccountabilityReport;
  text: string;
  sent: boolean;
}

export function runAccountabilityDigest(input: {
  now: Date;
  hours?: number;
  locale?: 'ja' | 'en';
  send?: boolean;
  options?: CharterPathOptions;
}): AccountabilityDigestEntry[] {
  const { now } = input;
  const options = input.options ?? {};
  return withExecutionContext('mission_controller', () =>
    listActiveCharters(now, options).map((charter) => {
      const report = buildAccountabilityReport({
        charter,
        ledger: readCharterLedger(charter, options),
        now,
        ...(input.hours !== undefined ? { hours: input.hours } : {}),
      });
      const text = renderAccountabilityReportText(report, { locale: input.locale ?? 'ja' });
      let sent = false;
      // An all-clear day is still sent: silence must never be ambiguous
      // between "nothing happened" and "the report broke".
      if (input.send) {
        sent = notifyOperatorSync(
          report.tripwires_standing.length > 0 ? 'ops_alert' : 'decision_digest',
          {
            title: text.split('\n')[0] ?? 'accountability report',
            body: text.split('\n').slice(1).join('\n'),
            correlation_id: `charter-report:${charter.charter_id}:${now.toISOString().slice(0, 10)}`,
          }
        );
      }
      return { report, text, sent };
    })
  );
}
