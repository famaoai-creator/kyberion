import type { DotDispatchDeps } from './dot-dispatch.js';
import { currentDotActions, type DotActionStatus } from './dot-action-ledger.js';
import { dotAdmissionScopeHash } from './dot-admission-identity.js';
import { dotDigestActionEvidence } from './dot-digest-evidence.js';
import { dotGoalRefLabel, listDotCharters, type DotCharter } from './dot-charter.js';
import { dotSignalStatusLines } from './dot-feedback.js';

/** Charter wall-clock zone: quiet hours first, then its first cron trigger. */
export function dotCharterTimezone(charter: DotCharter): string | undefined {
  if (charter.notification.quiet_hours?.timezone) return charter.notification.quiet_hours.timezone;
  for (const trigger of charter.attention.triggers) {
    if (trigger.kind === 'cron' && trigger.timezone) return trigger.timezone;
  }
  return undefined;
}

/** Compose the digest text: actions since the last digest, open decisions, signals. */
export function composeDotDigestText(
  charter: DotCharter,
  since: Date | undefined,
  deps: DotDispatchDeps = {},
  sectionLines: string[] = []
): string {
  const actions = currentDotActions(charter.dot_id, deps).filter(
    (row) => !row.admission || row.admission.scope_hash === dotAdmissionScopeHash(charter)
  );
  const evidenceDeps = {
    ...deps,
    listCharters:
      deps.listCharters ??
      (() => listDotCharters(deps.rootDir, { errors: [] }).map((loaded) => loaded.charter)),
  };
  const evidence = new Map(
    actions.map((row) => [row.action_ref, dotDigestActionEvidence(charter, row, evidenceDeps)])
  );
  const recent = actions.filter(
    (row) => !since || Date.parse(evidence.get(row.action_ref)?.at ?? row.at) >= since.getTime()
  );
  const count = (status: DotActionStatus) => recent.filter((row) => row.status === status).length;
  const waiting = actions.filter((row) => row.status === 'parked');
  const signals = dotSignalStatusLines(charter, { rootDir: deps.rootDir });
  return [
    `${charter.title}${dotGoalRefLabel(charter) ? ` — ${dotGoalRefLabel(charter)}` : ''}`,
    `Since last digest: dispatched ${count('dispatched')}, waiting ${waiting.length}, declined ${count('declined')}, refused ${count('refused')}.`,
    ...recent
      .filter((row) => row.status === 'dispatched' || row.status === 'admitted')
      .slice(-5)
      .map(
        (row) =>
          `- ${evidence.get(row.action_ref)?.status ?? 'queued'}: ${row.title}${row.work_item_id ? ` (${row.work_item_id})` : ''}`
      ),
    ...waiting.slice(0, 5).map((row) => `- waiting on you: ${row.title}`),
    ...(signals.length ? ['Signals:', ...signals] : []),
    ...sectionLines,
  ].join('\n');
}
