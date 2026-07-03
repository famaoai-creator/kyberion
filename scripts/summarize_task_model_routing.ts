import { pathResolver, safeExistsSync, safeReadFile } from '@agent/core';
import type { TaskModelEffort, TaskModelHint, TaskModelTier } from '@agent/core';

interface TaskIssueEvent {
  event_type?: string;
  mission_id?: string;
  task_id?: string;
  agent_id?: string;
  team_role?: string;
  payload?: {
    task_model_hint?: TaskModelHint;
  };
}

interface SupervisorAskCompletedEvent {
  decision?: string;
  agent_id?: string;
  model_id?: string;
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface TaskRoutingSample {
  mission_id: string;
  task_id: string;
  team_role: string;
  planned_tier: TaskModelTier;
  planned_effort: TaskModelEffort;
  planned_model_id: string;
  actual_model_id?: string;
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  rework_count: number;
}

export interface TaskRoutingSummaryRow {
  team_role: string;
  planned_tier: TaskModelTier;
  samples: number;
  avg_duration_ms: number;
  avg_input_tokens: number;
  avg_output_tokens: number;
  avg_total_tokens: number;
  avg_rework_count: number;
  actual_models: string[];
}

function parseJsonl<T>(raw: string): T[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

export function buildTaskRoutingSamples(
  taskEvents: TaskIssueEvent[],
  supervisorEvents: SupervisorAskCompletedEvent[]
): TaskRoutingSample[] {
  const issueCounts = new Map<string, number>();
  const samplesByAgent = new Map<string, TaskRoutingSample[]>();
  const samples: TaskRoutingSample[] = [];

  for (const event of taskEvents) {
    if (event.event_type !== 'task_issued') continue;
    const hint = event.payload?.task_model_hint;
    if (
      !event.mission_id ||
      !event.task_id ||
      !event.team_role ||
      !event.agent_id ||
      !hint ||
      (hint.tier !== 'small' && hint.tier !== 'standard' && hint.tier !== 'large')
    ) {
      continue;
    }
    const key = `${event.mission_id}:${event.task_id}`;
    const previousCount = issueCounts.get(key) || 0;
    issueCounts.set(key, previousCount + 1);
    const sample: TaskRoutingSample = {
      mission_id: event.mission_id,
      task_id: event.task_id,
      team_role: event.team_role,
      planned_tier: hint.tier,
      planned_effort: hint.effort,
      planned_model_id: hint.model_id,
      rework_count: previousCount,
    };
    samples.push(sample);
    const queued = samplesByAgent.get(event.agent_id) || [];
    queued.push(sample);
    samplesByAgent.set(event.agent_id, queued);
  }

  for (const event of supervisorEvents) {
    if (event.decision !== 'agent_runtime_ask_completed' || !event.agent_id) continue;
    const queued = samplesByAgent.get(event.agent_id);
    if (!queued || queued.length === 0) continue;
    const sample = queued.shift()!;
    sample.actual_model_id = event.model_id || sample.actual_model_id;
    sample.duration_ms = event.duration_ms;
    sample.input_tokens = event.input_tokens;
    sample.output_tokens = event.output_tokens;
    sample.total_tokens = event.total_tokens;
  }

  return samples;
}

export function summarizeTaskRouting(samples: TaskRoutingSample[]): TaskRoutingSummaryRow[] {
  const groups = new Map<string, TaskRoutingSample[]>();

  for (const sample of samples) {
    const key = `${sample.team_role}::${sample.planned_tier}`;
    const list = groups.get(key) || [];
    list.push(sample);
    groups.set(key, list);
  }

  return Array.from(groups.entries())
    .map(([key, list]) => {
      const [team_role, planned_tier] = key.split('::') as [string, TaskModelTier];
      const totals = list.reduce(
        (acc, sample) => {
          acc.duration += sample.duration_ms || 0;
          acc.inputTokens += sample.input_tokens || 0;
          acc.outputTokens += sample.output_tokens || 0;
          acc.totalTokens += sample.total_tokens || 0;
          acc.rework += sample.rework_count;
          if (sample.actual_model_id) acc.models.add(sample.actual_model_id);
          return acc;
        },
        {
          duration: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          rework: 0,
          models: new Set<string>(),
        }
      );
      const count = list.length || 1;
      return {
        team_role,
        planned_tier,
        samples: list.length,
        avg_duration_ms: Math.round(totals.duration / count),
        avg_input_tokens: Math.round(totals.inputTokens / count),
        avg_output_tokens: Math.round(totals.outputTokens / count),
        avg_total_tokens: Math.round(totals.totalTokens / count),
        avg_rework_count: Math.round((totals.rework / count) * 100) / 100,
        actual_models: Array.from(totals.models).sort(),
      };
    })
    .sort(
      (left, right) =>
        left.team_role.localeCompare(right.team_role) ||
        left.planned_tier.localeCompare(right.planned_tier)
    );
}

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

function readEvents(filePath: string): unknown[] {
  if (!safeExistsSync(filePath)) return [];
  return parseJsonl(safeReadFile(filePath, { encoding: 'utf8' }) as string);
}

function main() {
  const jsonOnly = process.argv.includes('--json');
  const taskEventsPath = process.argv.includes('--task-events')
    ? process.argv[process.argv.indexOf('--task-events') + 1]
    : pathResolver.shared('observability/mission-control/task-events.jsonl');
  const supervisorEventsPath = process.argv.includes('--supervisor-events')
    ? process.argv[process.argv.indexOf('--supervisor-events') + 1]
    : pathResolver.shared('observability/mission-control/agent-runtime-supervisor-events.jsonl');

  const samples = buildTaskRoutingSamples(
    readEvents(taskEventsPath) as TaskIssueEvent[],
    readEvents(supervisorEventsPath) as SupervisorAskCompletedEvent[]
  );
  const rows = summarizeTaskRouting(samples);

  if (jsonOnly) {
    console.log(JSON.stringify({ samples, rows }, null, 2));
    return;
  }

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

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
