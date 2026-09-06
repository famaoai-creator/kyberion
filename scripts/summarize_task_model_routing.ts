/**
 * summarize_task_model_routing.ts — thin CLI shell (LE-03).
 *
 * The aggregation logic lives in @agent/core report-ops and is exposed
 * in-process as the `system:summarize_task_model_routing` op. This shell
 * remains for direct CLI use (`--task-events/--supervisor-events/--output/--json`).
 */

import { pathResolver } from '@agent/core/path-resolver';
import {
  buildTaskRoutingSamples,
  runTaskModelRoutingSummary,
  summarizeTaskRouting,
  writeTaskRoutingSummary,
  type TaskRoutingSample,
  type TaskRoutingSummaryRow,
} from '@agent/core/report-ops';
import { defineScript, isDirectScript } from './lib/harness.js';

export {
  buildTaskRoutingSamples,
  summarizeTaskRouting,
  writeTaskRoutingSummary,
  type TaskRoutingSample,
  type TaskRoutingSummaryRow,
};

function formatRow(row: TaskRoutingSummaryRow): string {
  const models = row.actual_models.length > 0 ? row.actual_models.join(', ') : '-';
  return [
    row.team_role.padEnd(18),
    row.planned_tier.padEnd(9),
    String(row.samples).padStart(4),
    String(row.avg_duration_ms).padStart(8),
    String(row.avg_input_tokens).padStart(8),
    String(row.avg_output_tokens).padStart(8),
    String(row.avg_total_tokens).padStart(8),
    String(row.avg_rework_count).padStart(8),
    models,
  ].join('  ');
}

function argValue(argv: string[], name: string): string | undefined {
  return argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
}

export const TASK_MODEL_ROUTING_USAGE =
  'Usage: pnpm task:summarize-model-routing [--task-events <path>] [--supervisor-events <path>] [--output <path>] [--json]';

export function main(argv: string[] = []): { output?: unknown; help?: string } {
  if (argv.includes('--help') || argv.includes('-h')) return { help: TASK_MODEL_ROUTING_USAGE };

  const jsonOnly = argv.includes('--json');
  const outputPathArg = argValue(argv, '--output');

  const { samples, rows, output_path } = runTaskModelRoutingSummary({
    task_events_path: argValue(argv, '--task-events'),
    supervisor_events_path: argValue(argv, '--supervisor-events'),
    output_path: outputPathArg,
  });
  const outputPath = output_path || pathResolver.sharedTmp('task-model-routing-summary.json');

  if (jsonOnly) {
    if (!outputPathArg) {
      return { output: { samples, rows } };
    } else {
      return { output: outputPath };
    }
  }

  if (outputPathArg) {
    return { output: `Task model routing summary written to ${outputPath}` };
  } else {
    const lines = [
      'team_role           tier       samp  dur(ms)  in_tok  out_tok  tot_tok  rework  actual_models',
      '----------------------------------------------------------------------------------------------',
    ];
    lines.push(...rows.map(formatRow), '', `samples=${samples.length} groups=${rows.length}`);
    return { output: lines.join('\n') };
  }
}

export const runSummarizeTaskModelRouting = defineScript({
  name: 'task:summarize-model-routing',
  flags: ['json'],
  run: ({ argv, json, print }) => {
    const result = main(argv);
    if (result.help) print(json ? result : result.help);
    else if (result.output !== undefined) print(result.output);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'summarize_task_model_routing.ts') ||
  isDirectScript(import.meta.url, 'summarize_task_model_routing.js')
)
  void runSummarizeTaskModelRouting();
