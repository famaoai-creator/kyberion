/**
 * summarize_task_model_routing.ts — thin CLI shell (LE-03).
 *
 * The aggregation logic lives in @agent/core report-ops and is exposed
 * in-process as the `system:summarize_task_model_routing` op. This shell
 * remains for direct CLI use (`--task-events/--supervisor-events/--output/--json`).
 */

import { pathResolver } from '@agent/core';
import {
  buildTaskRoutingSamples,
  runTaskModelRoutingSummary,
  summarizeTaskRouting,
  writeTaskRoutingSummary,
  type TaskRoutingSample,
  type TaskRoutingSummaryRow,
} from '@agent/core';

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

function argValue(name: string): string | undefined {
  return process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
}

function main() {
  const jsonOnly = process.argv.includes('--json');
  const outputPathArg = argValue('--output');

  const { samples, rows, output_path } = runTaskModelRoutingSummary({
    task_events_path: argValue('--task-events'),
    supervisor_events_path: argValue('--supervisor-events'),
    output_path: outputPathArg,
  });
  const outputPath = output_path || pathResolver.sharedTmp('task-model-routing-summary.json');

  if (jsonOnly) {
    if (!outputPathArg) {
      console.log(JSON.stringify({ samples, rows }, null, 2));
    } else {
      console.log(outputPath);
    }
    return;
  }

  if (outputPathArg) {
    console.log(`Task model routing summary written to ${outputPath}`);
  } else {
    console.log(
      'team_role           tier       samp  dur(ms)  in_tok  out_tok  tot_tok  rework  actual_models'
    );
    console.log(
      '----------------------------------------------------------------------------------------------'
    );
    for (const row of rows) {
      console.log(formatRow(row));
    }
    console.log('');
    console.log(`samples=${samples.length} groups=${rows.length}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
