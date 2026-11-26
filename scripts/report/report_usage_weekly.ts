/**
 * Weekly Kyberion usage report — volume, sessions, tool mix, tenants touched,
 * missions, trigger failures (host sleep split out), dot denials and the
 * execution origin split (interactive CLI / Dot wakes / triggers & daemons /
 * supervisor-hosted runtimes / other, with LLM calls and tokens from the
 * execution-metrics ledger), plus rule-derived improvement candidates.
 *
 *   pnpm usage:weekly                          # previous full week (Mon–Sun, JST)
 *   pnpm usage:weekly -- --week 2026-11-16     # a specific week (Monday, JST)
 *   pnpm usage:weekly -- --out <path.md>       # write somewhere else
 *   pnpm usage:weekly -- --json                # JSON report on stdout
 *
 * Default output: active/shared/runtime/reports/usage-weekly/usage-weekly-<week>.md
 * (+ .json). That is the established home of generated system reports
 * (mission-hygiene, janitor) with a 90-day audited retention entry; the report
 * is derived from the audit chain, carries counts and categories only, and
 * can be regenerated for as long as the audit files exist.
 */

import * as path from 'node:path';
import { writeJson } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';
import {
  collectUsageWeeklyReport,
  renderUsageWeeklyMarkdown,
  resolveUsageWeek,
  type UsageWeeklyReport,
} from './usage_weekly_aggregate.js';

export function defaultUsageWeeklyReportPath(week: string): string {
  return pathResolver.shared(`runtime/reports/usage-weekly/usage-weekly-${week}.md`);
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new ScriptExitError(2, `${name} requires a value`);
  }
  return value;
}

export interface UsageWeeklyRunResult {
  report: UsageWeeklyReport;
  markdown_path: string;
  json_path: string;
}

/** Build the report for `week` (default: previous full week) and write .md + .json. */
export function runUsageWeeklyReportOnce(
  options: {
    week?: string;
    out?: string;
    now?: Date;
    auditDir?: string;
    metricsFile?: string;
    metricsPartitionRoot?: string;
    supervisorDir?: string;
  } = {}
): UsageWeeklyRunResult {
  const window = resolveUsageWeek(options.week, options.now);
  const report = collectUsageWeeklyReport({
    window,
    auditDir: options.auditDir,
    metricsFile: options.metricsFile,
    metricsPartitionRoot: options.metricsPartitionRoot,
    supervisorDir: options.supervisorDir,
    now: options.now,
  });
  const markdownPath = path.resolve(options.out ?? defaultUsageWeeklyReportPath(window.week));
  const jsonPath = markdownPath.replace(/\.(md|json)$/u, '') + '.json';
  if (jsonPath === markdownPath) throw new Error('--out must name the Markdown file (.md)');
  const dir = path.dirname(markdownPath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(markdownPath, renderUsageWeeklyMarkdown(report));
  writeJson(jsonPath, report);
  return { report, markdown_path: markdownPath, json_path: jsonPath };
}

export const runUsageWeekly = defineScript({
  name: 'usage:weekly',
  flags: ['json'],
  run(context) {
    let result: UsageWeeklyRunResult;
    try {
      result = runUsageWeeklyReportOnce({
        week: flagValue(context.argv, '--week'),
        out: flagValue(context.argv, '--out'),
      });
    } catch (error) {
      if (error instanceof ScriptExitError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/--week/u.test(message)) throw new ScriptExitError(2, message);
      throw error;
    }
    const { report } = result;
    context.print(
      context.json
        ? JSON.stringify({ ...report, markdown_path: result.markdown_path }, null, 2)
        : [
            `Usage report for week of ${report.window.week} (JST): ${result.markdown_path}`,
            `events ${report.current.total_events}, prompts ${report.current.prompts}, sessions ${report.current.sessions.count}, ` +
              `trigger failures ${report.current.trigger.failed} (host_suspended ${report.current.trigger.host_suspended}), ` +
              `improvement candidates ${report.improvement_candidates.length}`,
            `LLM calls by origin: ${report.execution_origin.by_origin
              .map((row) => `${row.origin} ${row.llm_calls}`)
              .join(', ')}`,
          ].join('\n')
    );
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'report_usage_weekly.ts') ||
  isDirectScript(import.meta.url, 'report_usage_weekly.js')
)
  void runUsageWeekly();
