import AjvModule from 'ajv';
import * as path from 'node:path';
import {
  buildMissionOrchestrationEvaluationReport,
  pathResolver,
  safeMkdir,
  safeWriteFile,
} from '@agent/core';
import { readJsonFile } from './refactor/cli-input.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true });

interface ScenarioRunRecord {
  scenario_id: string;
  mode: 'baseline' | 'orchestrated';
  completion_status: 'completed' | 'blocked' | 'failed';
  clarification_count: number;
  policy_violations: number;
  contract_valid: boolean;
  operator_corrections: number;
}

function readJson<T>(filePath: string): T {
  return readJsonFile(filePath);
}

function compileSchema(schemaPath: string) {
  return ajv.compile(readJson<Record<string, unknown>>(schemaPath));
}

function parseArg(name: string, fallback?: string): string {
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument: ${name}`);
}

function main() {
  const runsPath = parseArg('--runs');
  const outPath = parseArg('--out', pathResolver.shared('evaluations/mission-orchestration/evaluation-report.json'));
  const runs = readJson<ScenarioRunRecord[]>(runsPath);
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error('Run record input must be a non-empty array.');
  }

  const report = buildMissionOrchestrationEvaluationReport(runs);
  const reportSchemaPath = pathResolver.knowledge('public/schemas/mission-orchestration-evaluation-report.schema.json');
  const validate = compileSchema(reportSchemaPath);
  if (!validate(report)) {
    const errors = (validate.errors || []).map((error: any) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`).join('; ');
    throw new Error(`Evaluation report validation failed: ${errors}`);
  }

  const resolvedOutPath = pathResolver.resolve(outPath);
  safeMkdir(path.dirname(resolvedOutPath), { recursive: true });
  safeWriteFile(resolvedOutPath, JSON.stringify(report, null, 2));
  console.log(`[evaluate:mission-orchestration] wrote report to ${outPath}`);
  console.log(`[evaluate:mission-orchestration] completion delta: ${report.summary.orchestrated_completion_rate_delta}`);
  console.log(`[evaluate:mission-orchestration] policy violation delta: ${report.summary.orchestrated_policy_violations_delta}`);
}

main();
