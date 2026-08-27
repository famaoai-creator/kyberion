import * as path from 'node:path';
import {
  buildMissionOrchestrationEvaluationReport,
  pathResolver,
  safeMkdir,
  safeWriteFile,
} from '@agent/core';
import { createAjv, readJson as readFoundationJson } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';

const ajv = createAjv();

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

function readJson<T>(filePath: string): T {
  return readFoundationJson<T>(filePath);
}

function compileSchema(schemaPath: string) {
  return ajv.compile(readJson<Record<string, unknown>>(schemaPath));
}

function parseArg(argv: string[], name: string, fallback?: string): string {
  const prefixed = argv.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument: ${name}`);
}

export function main(argv: string[] = []): void {
  const runsPath = parseArg(argv, '--runs');
  const outPath = parseArg(
    argv,
    '--out',
    pathResolver.shared('evaluations/mission-orchestration/evaluation-report.json')
  );
  const runs = readJson<ScenarioRunRecord[]>(runsPath);
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error('Run record input must be a non-empty array.');
  }

  const report = buildMissionOrchestrationEvaluationReport(runs);
  const reportSchemaPath = pathResolver.knowledge(
    'product/schemas/mission-orchestration-evaluation-report.schema.json'
  );
  const validate = compileSchema(reportSchemaPath);
  if (!validate(report)) {
    const errors = (validate.errors || [])
      .map((error: any) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
      .join('; ');
    throw new Error(`Evaluation report validation failed: ${errors}`);
  }

  const resolvedOutPath = pathResolver.resolve(outPath);
  safeMkdir(path.dirname(resolvedOutPath), { recursive: true });
  safeWriteFile(resolvedOutPath, JSON.stringify(report, null, 2));
  console.log(`[evaluate:mission-orchestration] wrote report to ${outPath}`);
  console.log(
    `[evaluate:mission-orchestration] completion delta: ${report.summary.orchestrated_completion_rate_delta}`
  );
  console.log(
    `[evaluate:mission-orchestration] policy violation delta: ${report.summary.orchestrated_policy_violations_delta}`
  );
  console.log(
    `[evaluate:mission-orchestration] average context chars / needs rate: ${report.mode_metrics.orchestrated.average_context_chars_per_run} / ${report.mode_metrics.orchestrated.needs_rate_per_run}`
  );
}

export const runEvaluateMissionOrchestration = defineScript({
  name: 'evaluate:mission-orchestration',
  flags: [],
  run: ({ argv }) => main(argv),
});

if (
  isDirectScript(import.meta.url, 'evaluate_mission_orchestration.ts') ||
  isDirectScript(import.meta.url, 'evaluate_mission_orchestration.js')
)
  void runEvaluateMissionOrchestration();
