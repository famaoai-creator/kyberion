import { createStandardYargs } from '@agent/core/cli-utils';
import { assessPipelineDryRun } from '@agent/core';
import { readValidatedWorkflowAdf } from './refactor/adf-input.js';

export async function runPipelineDryRun(
  inputPath: string
): Promise<ReturnType<typeof assessPipelineDryRun>> {
  try {
    const pipeline = await readValidatedWorkflowAdf(inputPath);
    return assessPipelineDryRun(pipeline as Parameters<typeof assessPipelineDryRun>[0]);
  } catch (error) {
    return {
      version: '1.0',
      pipeline_id: inputPath,
      verdict: 'blocked',
      side_effects: 'none',
      checks: [
        {
          id: 'contract-validation',
          status: 'blocked',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      next_actions: ['Fix the pipeline ADF/guardrail validation errors and rerun the dry-run.'],
    };
  }
}

export async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('json', { type: 'boolean', default: false })
    .parseSync();
  const report = await runPipelineDryRun(String(argv.input));
  if (argv.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`[pipeline-dry-run] ${report.verdict}: ${report.pipeline_id}\n`);
    for (const check of report.checks)
      process.stdout.write(`- ${check.status}: ${check.message}\n`);
    for (const action of report.next_actions) process.stdout.write(`next: ${action}\n`);
  }
  process.exitCode = report.verdict === 'blocked' ? 1 : 0;
}

if (process.argv[1] && /run_pipeline_dry_run\.(ts|js)$/u.test(process.argv[1])) void main();
