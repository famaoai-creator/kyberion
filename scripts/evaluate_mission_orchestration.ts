import * as path from 'node:path';
import { buildMissionOrchestrationEvaluationReport } from '@agent/core/mission-orchestration-evaluator';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { defineCatalog } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';

interface ScenarioRunRecord {
  scenario_id: string;
  mode: 'baseline' | 'orchestrated';
  completion_status: 'completed' | 'blocked' | 'failed';
  clarification_count: number;
  policy_violations: number;
  contract_valid: boolean;
  operator_corrections: number;
  context_chars?: number;
  rollup_used?: boolean;
  result_schema_ok?: boolean;
  needs_count?: number;
}

const RUNS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-orchestration-scenario-runs.schema.json'
);
const REPORT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-orchestration-evaluation-report.schema.json'
);

function loadScenarioRuns(filePath: string): ScenarioRunRecord[] {
  return defineCatalog<ScenarioRunRecord[]>({
    id: 'mission-orchestration-scenario-runs',
    path: filePath,
    schema: RUNS_SCHEMA_PATH,
  }).load();
}

function validateReport(
  report: ReturnType<typeof buildMissionOrchestrationEvaluationReport>
): void {
  defineCatalog<ReturnType<typeof buildMissionOrchestrationEvaluationReport>>({
    id: 'mission-orchestration-evaluation-report',
    path: REPORT_SCHEMA_PATH,
    schema: REPORT_SCHEMA_PATH,
  }).validate(report, REPORT_SCHEMA_PATH);
}

function parseArg(argv: string[], name: string, fallback?: string): string {
  const prefixed = argv.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument: ${name}`);
}

export function main(argv: string[], print: (value: unknown) => void, json = false): void {
  const runsPath = parseArg(argv, '--runs');
  const outPath = parseArg(
    argv,
    '--out',
    pathResolver.shared('evaluations/mission-orchestration/evaluation-report.json')
  );
  const runs = loadScenarioRuns(runsPath);
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error('Run record input must be a non-empty array.');
  }

  const report = buildMissionOrchestrationEvaluationReport(runs);
  validateReport(report);

  const resolvedOutPath = assertSafeRepositoryPath(pathResolver.resolve(outPath), {
    allowMissingLeaf: true,
  });
  safeMkdir(path.dirname(resolvedOutPath), { recursive: true });
  safeWriteFile(resolvedOutPath, JSON.stringify(report, null, 2));
  if (json) {
    print({
      ok: true,
      report_path: outPath,
      report,
    });
    return;
  }
  print(
    [
      `[evaluate:mission-orchestration] wrote report to ${outPath}`,
      `[evaluate:mission-orchestration] completion delta: ${report.summary.orchestrated_completion_rate_delta}`,
      `[evaluate:mission-orchestration] policy violation delta: ${report.summary.orchestrated_policy_violations_delta}`,
      `[evaluate:mission-orchestration] average context chars / needs rate: ${report.mode_metrics.orchestrated.average_context_chars_per_run} / ${report.mode_metrics.orchestrated.needs_rate_per_run}`,
    ].join('\n')
  );
}

export const runEvaluateMissionOrchestration = defineScript({
  name: 'evaluate:mission-orchestration',
  flags: ['json'],
  run: ({ argv, json, print }) => main(argv, print, json),
});

if (
  isDirectScript(import.meta.url, 'evaluate_mission_orchestration.ts') ||
  isDirectScript(import.meta.url, 'evaluate_mission_orchestration.js')
)
  void runEvaluateMissionOrchestration();
