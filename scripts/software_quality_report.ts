#!/usr/bin/env node
import * as path from 'node:path';

import {
  buildSoftwareQualityReport,
  createDefectCandidates,
  loadJson,
  safeMkdir,
  safeWriteFile,
  type SoftwareQualityContract,
  type TestExecutionRecord,
  type TestInventory,
} from '@agent/core';
import { defineScript, isDirectScript } from './lib/harness.js';

export interface SoftwareQualityReportInput {
  contractPath: string;
  inventoryPath: string;
  executionPath: string;
  outputPath: string;
  defectsPath?: string;
  publishSummaryPath?: string;
  requiredRiskRefs?: string[];
  now?: Date;
}

function writeJson(filePath: string, value: unknown): void {
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
}

export function generateSoftwareQualityArtifacts(input: SoftwareQualityReportInput): {
  reportPath: string;
  defectsPath: string;
  recommendation: string;
  defectCount: number;
} {
  const contract = loadJson<SoftwareQualityContract>(input.contractPath);
  const inventory = loadJson<TestInventory>(input.inventoryPath);
  const execution = loadJson<TestExecutionRecord>(input.executionPath);
  const summary = buildSoftwareQualityReport({
    contract,
    inventory,
    execution,
    requiredRiskRefs: input.requiredRiskRefs,
    now: input.now,
  });
  const defects = createDefectCandidates({ inventory, execution });
  const defectsPath =
    input.defectsPath ?? path.join(path.dirname(input.outputPath), 'defect-candidates.json');
  const generatedAt = (input.now ?? new Date()).toISOString();
  const report = {
    version: '1.0.0',
    report_id: `QUALITY-${execution.run_id}`,
    project_id: contract.project_id,
    subject_ref: execution.subject_ref,
    generated_at: generatedAt,
    ...summary,
  };
  writeJson(input.outputPath, report);
  if (input.publishSummaryPath) writeJson(input.publishSummaryPath, report);
  writeJson(defectsPath, {
    version: '1.0.0',
    project_id: contract.project_id,
    generated_at: generatedAt,
    defects,
  });
  return {
    reportPath: input.outputPath,
    defectsPath,
    recommendation: summary.recommendation,
    defectCount: defects.length,
  };
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseArgs(args: string[]): SoftwareQualityReportInput {
  const contractPath = valueAfter(args, '--contract');
  const inventoryPath = valueAfter(args, '--inventory');
  const executionPath = valueAfter(args, '--execution');
  const outputPath = valueAfter(args, '--output');
  if (!contractPath || !inventoryPath || !executionPath || !outputPath) {
    throw new Error(
      'Usage: software_quality_report --contract <file> --inventory <file> --execution <file> --output <file> [--defects <file>] [--required-risks R1,R2]'
    );
  }
  return {
    contractPath,
    inventoryPath,
    executionPath,
    outputPath,
    defectsPath: valueAfter(args, '--defects'),
    publishSummaryPath: valueAfter(args, '--publish-summary'),
    requiredRiskRefs: (valueAfter(args, '--required-risks') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

export const runSoftwareQualityReport = defineScript({
  name: 'software-quality-report',
  flags: [],
  run(context) {
    const result = generateSoftwareQualityArtifacts(parseArgs(context.argv));
    context.print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'software_quality_report.ts') ||
  isDirectScript(import.meta.url, 'software_quality_report.js')
)
  void runSoftwareQualityReport();
