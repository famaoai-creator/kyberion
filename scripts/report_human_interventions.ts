import { withExecutionContext } from '@agent/core/authority';
import { listApprovalRequests, type ApprovalRequestRecord } from '@agent/core/approval-store';
import { isFixtureApproval } from '@agent/core/approval-store-hygiene';
import { listMissionsInSearchDirs, loadStateAtPath } from '@agent/core/mission-state';
import { safeExecResult } from '@agent/core/secure-io';
import * as path from 'node:path';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

/**
 * Autonomous-operation P0: count where a human is still needed — planning,
 * PR merges, conflicts, secrets, plugin installs, pipeline gates, steering —
 * so the decision-rights matrix is set from recorded data, not impressions.
 *
 * Read-only. Most PR merges and conflict resolutions never touch the
 * approval store, so git history is a first-class source here, not a fallback.
 */

export type InterventionCategory =
  | 'planning'
  | 'pr_merge'
  | 'conflict'
  | 'secret'
  | 'plugin_install'
  | 'pipeline_gate'
  | 'steering'
  | 'other';

export type InterventionResolution = 'human' | 'agent' | 'unresolved' | 'unattributed';

export interface HumanIntervention {
  source: 'approval_store' | 'git' | 'mission_state';
  category: InterventionCategory;
  resolution: InterventionResolution;
  occurredAt: string;
  waitMs?: number;
  ref: string;
}

export interface CategorySummary {
  total: number;
  human: number;
  agent: number;
  unresolved: number;
  unattributed: number;
  medianWaitMs: number | null;
}

export interface HumanInterventionReport {
  generatedAt: string;
  since: string;
  totals: CategorySummary;
  byCategory: Record<InterventionCategory, CategorySummary>;
  /** Missions currently planned/paused; a snapshot, not limited to `since`. */
  missionWaitsSnapshot: number;
  excludedFixtures: number;
  warnings: string[];
  items: HumanIntervention[];
}

export { isFixtureApproval };

export const INTERVENTION_CATEGORIES: readonly InterventionCategory[] = [
  'planning',
  'pr_merge',
  'conflict',
  'secret',
  'plugin_install',
  'pipeline_gate',
  'steering',
  'other',
];

// Older policy auto-approvals were stamped decidedByType=human; for those
// records the workflow note is the only durable marker that no human acted.
const AUTO_APPROVAL_NOTE = /^auto-approved/i;
const CHAT_CHANNELS = new Set(['slack', 'telegram', 'discord', 'imessage']);
const BOT_AUTHOR = /\[bot\]|github-actions|dependabot|renovate/i;
const PR_MERGE_SUBJECT = /^Merge pull request #(\d+)/;
const PR_SQUASH_SUBJECT = /\(#(\d+)\)$/;
const MAIN_SYNC_SUBJECT = /^Merge (?:remote-tracking )?branch '(?:origin\/)?main'/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/;
const MAX_CONFLICT_REPLAYS = 500;

export const PR_ATTRIBUTION_NOTE =
  'PR merge attribution uses the merge commit author; an agent merging with the operator token counts as human, and squash merges are unattributed';

export function isPolicyAutoApproval(record: Pick<ApprovalRequestRecord, 'workflow'>): boolean {
  const decided = (record.workflow?.approvals ?? []).filter(
    (entry) => (entry as { status?: string }).status !== 'pending'
  );
  return (
    decided.length > 0 &&
    decided.every((entry) =>
      AUTO_APPROVAL_NOTE.test(String((entry as { note?: unknown }).note ?? ''))
    )
  );
}

export function classifyApproval(
  record: Pick<ApprovalRequestRecord, 'kind' | 'storageChannel' | 'steering'>
): InterventionCategory {
  const channel = (record.storageChannel || '').toLowerCase();
  if (record.kind === 'secret_mutation') return 'secret';
  if (record.kind === 'mission_gate') {
    return channel === 'pipeline-approval' ? 'pipeline_gate' : 'planning';
  }
  if (channel === 'plugin-install') return 'plugin_install';
  if (channel === 'project-trust' || channel === 'pipeline-approval') return 'pipeline_gate';
  if (record.steering || CHAT_CHANNELS.has(channel)) return 'steering';
  return 'other';
}

export function approvalToIntervention(record: ApprovalRequestRecord): HumanIntervention {
  let resolution: InterventionResolution;
  if (record.status === 'pending') resolution = 'unresolved';
  else if (isPolicyAutoApproval(record)) resolution = 'agent';
  else if (record.decidedByType === 'human') resolution = 'human';
  else if (record.decidedByType === 'ai_agent' || record.decidedByType === 'service')
    resolution = 'agent';
  else resolution = 'unattributed';

  const requested = Date.parse(record.requestedAt);
  const decided = record.decidedAt ? Date.parse(record.decidedAt) : Number.NaN;
  const waitMs =
    Number.isFinite(requested) && Number.isFinite(decided) && decided >= requested
      ? decided - requested
      : undefined;

  return {
    source: 'approval_store',
    category: classifyApproval(record),
    resolution,
    occurredAt: record.requestedAt,
    ...(waitMs !== undefined ? { waitMs } : {}),
    ref: `approval:${record.storageChannel}/${record.id}`,
  };
}

export interface GitCommit {
  sha: string;
  parents: string[];
  author: string;
  committedAt: string;
  subject: string;
}

export const GIT_LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%cI%x1f%s';

export function parseGitLog(output: string): GitCommit[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha = '', parents = '', author = '', committedAt = '', subject = ''] =
        line.split('\x1f');
      return { sha, parents: parents.split(' ').filter(Boolean), author, committedAt, subject };
    })
    .filter((commit) => commit.sha);
}

export function prMergeToIntervention(commit: GitCommit): HumanIntervention | null {
  if (commit.parents.length >= 2) {
    const match = PR_MERGE_SUBJECT.exec(commit.subject);
    if (!match) return null;
    return {
      source: 'git',
      category: 'pr_merge',
      resolution: BOT_AUTHOR.test(commit.author) ? 'agent' : 'human',
      occurredAt: commit.committedAt,
      ref: `pr:#${match[1]}`,
    };
  }
  const squash = PR_SQUASH_SUBJECT.exec(commit.subject);
  if (!squash) return null;
  return {
    source: 'git',
    category: 'pr_merge',
    resolution: 'unattributed',
    occurredAt: commit.committedAt,
    ref: `pr:#${squash[1]}`,
  };
}

export function isMainSyncMerge(commit: GitCommit): boolean {
  return commit.parents.length >= 2 && MAIN_SYNC_SUBJECT.test(commit.subject);
}

export function conflictToIntervention(commit: GitCommit): HumanIntervention {
  return {
    source: 'git',
    category: 'conflict',
    resolution: 'unattributed',
    occurredAt: commit.committedAt,
    ref: `commit:${commit.sha.slice(0, 12)}`,
  };
}

export function missionStateToIntervention(
  missionId: string,
  status: string,
  updatedAt: string
): HumanIntervention | null {
  if (status !== 'planned' && status !== 'paused') return null;
  return {
    source: 'mission_state',
    category: status === 'planned' ? 'planning' : 'steering',
    resolution: 'unresolved',
    occurredAt: updatedAt,
    ref: `mission:${missionId}`,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function summarize(items: HumanIntervention[]): CategorySummary {
  const count = (resolution: InterventionResolution) =>
    items.filter((item) => item.resolution === resolution).length;
  return {
    total: items.length,
    human: count('human'),
    agent: count('agent'),
    unresolved: count('unresolved'),
    unattributed: count('unattributed'),
    medianWaitMs: median(
      items
        .filter((item) => item.resolution === 'human' && item.waitMs !== undefined)
        .map((item) => item.waitMs as number)
    ),
  };
}

function timeOf(item: HumanIntervention): number {
  const ms = Date.parse(item.occurredAt);
  return Number.isFinite(ms) ? ms : 0;
}

export function buildHumanInterventionReport(input: {
  items: HumanIntervention[];
  since: string;
  generatedAt: string;
  excludedFixtures: number;
  warnings?: string[];
}): HumanInterventionReport {
  const sinceMs = Date.parse(input.since);
  if (!Number.isFinite(sinceMs)) throw new Error(`Invalid since date: ${input.since}`);
  const warnings = [...(input.warnings ?? [])];
  let undated = 0;
  const items = input.items
    .filter((item) => {
      if (item.source === 'mission_state') return true;
      const ms = Date.parse(item.occurredAt);
      if (!Number.isFinite(ms)) {
        undated += 1;
        return false;
      }
      return ms >= sinceMs;
    })
    .sort((a, b) => timeOf(a) - timeOf(b) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  if (undated > 0) warnings.push(`${undated} item(s) without a parseable timestamp were skipped`);
  const byCategory = Object.fromEntries(
    INTERVENTION_CATEGORIES.map((category) => [
      category,
      summarize(items.filter((item) => item.category === category)),
    ])
  ) as Record<InterventionCategory, CategorySummary>;
  return {
    generatedAt: input.generatedAt,
    since: input.since,
    totals: summarize(items),
    byCategory,
    missionWaitsSnapshot: items.filter((item) => item.source === 'mission_state').length,
    excludedFixtures: input.excludedFixtures,
    warnings,
    items,
  };
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return hours < 48 ? `${hours.toFixed(1)}h` : `${(hours / 24).toFixed(1)}d`;
}

function formatRow(label: string, s: CategorySummary): string {
  return [
    label.padEnd(15),
    String(s.total).padStart(5),
    String(s.human).padStart(6),
    String(s.agent).padStart(6),
    String(s.unresolved).padStart(11),
    String(s.unattributed).padStart(13),
    `  ${formatDuration(s.medianWaitMs)}`,
  ].join('');
}

export function formatHumanInterventionReport(report: HumanInterventionReport): string {
  const lines = [
    `Human intervention census since ${report.since}`,
    '',
    'category        total  human  agent  unresolved  unattributed  median wait (human)',
    ...INTERVENTION_CATEGORIES.map((category) => formatRow(category, report.byCategory[category])),
    formatRow('total', report.totals),
    '',
    `Current mission waits (planned/paused, not limited to the window): ${report.missionWaitsSnapshot}`,
    `Excluded test-fixture approvals: ${report.excludedFixtures}`,
  ];
  for (const warning of report.warnings) lines.push(`note: ${warning}`);
  return lines.join('\n');
}

function runGit(args: string[], cwd: string): { stdout: string; status: number | null } {
  const result = safeExecResult('git', args, { cwd });
  return { stdout: result.stdout, status: result.status };
}

export function collectHumanInterventions(options: {
  since: string;
  repoRoot?: string;
  mainRef?: string;
}): { items: HumanIntervention[]; excludedFixtures: number; warnings: string[] } {
  const repoRoot = options.repoRoot ?? process.cwd();
  const mainRef = options.mainRef ?? 'origin/main';
  const items: HumanIntervention[] = [];
  const warnings: string[] = [];
  let excludedFixtures = 0;

  for (const record of listApprovalRequests()) {
    if (isFixtureApproval(record)) {
      excludedFixtures += 1;
      continue;
    }
    items.push(approvalToIntervention(record));
  }

  const mainLog = runGit(
    ['log', '--first-parent', mainRef, `--since=${options.since}`, `--format=${GIT_LOG_FORMAT}`],
    repoRoot
  );
  if (mainLog.status === 0) {
    let prCount = 0;
    for (const commit of parseGitLog(mainLog.stdout)) {
      const intervention = prMergeToIntervention(commit);
      if (intervention) {
        items.push(intervention);
        prCount += 1;
      }
    }
    if (prCount > 0) warnings.push(PR_ATTRIBUTION_NOTE);
  } else {
    warnings.push(`git log on ${mainRef} failed; PR merges not counted`);
  }

  const syncLog = runGit(
    [
      'log',
      '--branches',
      '--remotes=origin',
      '--merges',
      `--since=${options.since}`,
      `--format=${GIT_LOG_FORMAT}`,
    ],
    repoRoot
  );
  if (syncLog.status === 0) {
    const syncs = parseGitLog(syncLog.stdout).filter(isMainSyncMerge);
    if (syncs.length > MAX_CONFLICT_REPLAYS) {
      warnings.push(
        `only the latest ${MAX_CONFLICT_REPLAYS} of ${syncs.length} main syncs replayed`
      );
    }
    let replayFailures = 0;
    for (const commit of syncs.slice(0, MAX_CONFLICT_REPLAYS)) {
      const replay = runGit(
        ['merge-tree', '--write-tree', '--quiet', commit.parents[0], commit.parents[1]],
        repoRoot
      );
      if (replay.status === 1) items.push(conflictToIntervention(commit));
      else if (replay.status !== 0) replayFailures += 1;
    }
    if (replayFailures > 0) {
      warnings.push(
        `${replayFailures} merge-tree replay(s) failed (git >= 2.38 required); conflicts may be undercounted`
      );
    }
  } else {
    warnings.push('git log of local and origin branches failed; conflicts not counted');
  }

  for (const { missionId, missionPath } of listMissionsInSearchDirs()) {
    const state = loadStateAtPath(path.join(missionPath, 'mission-state.json'));
    if (!state) {
      warnings.push(`unreadable mission state: ${missionId}`);
      continue;
    }
    const lastEvent = state.history?.[state.history.length - 1];
    const intervention = missionStateToIntervention(
      missionId,
      String(state.status ?? ''),
      String(lastEvent?.ts ?? '')
    );
    if (intervention) items.push(intervention);
  }

  return { items, excludedFixtures, warnings };
}

function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new ScriptExitError(2, `${flag} requires a value`);
  return value;
}

export const runReportHumanInterventions = defineScript({
  name: 'report:human-interventions',
  flags: ['json'],
  run(context) {
    const now = new Date();
    const since =
      readFlag(context.argv, '--since') ??
      new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (!ISO_DATE.test(since) || !Number.isFinite(Date.parse(since))) {
      throw new ScriptExitError(2, `--since must be an ISO date (YYYY-MM-DD), got: ${since}`);
    }
    const mainRef = readFlag(context.argv, '--main-ref');
    const collected = withExecutionContext('mission_controller', () =>
      collectHumanInterventions({ since, ...(mainRef ? { mainRef } : {}) })
    );
    const report = buildHumanInterventionReport({
      ...collected,
      since,
      generatedAt: now.toISOString(),
    });
    context.print(
      context.json ? JSON.stringify(report, null, 2) : formatHumanInterventionReport(report)
    );
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'report_human_interventions.ts') ||
  isDirectScript(import.meta.url, 'report_human_interventions.js')
)
  void runReportHumanInterventions();
