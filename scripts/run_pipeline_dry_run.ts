import { createStandardYargs } from '@agent/core/cli-utils';
import { assessPipelineDryRun } from '@agent/core/pipeline/pipeline-dry-run';
import { pathResolver } from '@agent/core/path-resolver';
import { isBuiltinPipelineResource } from '@agent/core/trust-requiring-resources';
import { expandPipelineIncludesForDryRun, readValidatedWorkflowAdf } from './refactor/adf-input.js';
import {
  currentProcessArgv,
  defineScript,
  isDirectScript,
  ScriptExitError,
} from './lib/harness.js';

export async function runPipelineDryRun(
  inputPath: string,
  options: { projectTrustApprovalId?: string } = {}
): Promise<ReturnType<typeof assessPipelineDryRun>> {
  try {
    const resolvedPath = pathResolver.rootResolve(inputPath);
    const projectTrustApprovalId = options.projectTrustApprovalId?.trim() || undefined;
    const trustResolved =
      isBuiltinPipelineResource(pathResolver.toRepoRelative(resolvedPath)) &&
      !projectTrustApprovalId;
    const pipeline = await readValidatedWorkflowAdf(inputPath, {
      trustResolved,
      projectTrustApprovalId,
    });
    // Static includes are resolved exactly like the guardrail preflight sees
    // them — fragment ops get capability checks — while each include's
    // declared produces/export_as channel stays visible to the flow check
    // (runtime writes the include result into context under that name).
    // Dynamic ({{placeholder}}) refs stay for runtime, matching execution.
    const expanded = expandPipelineIncludesForDryRun(pipeline, {
      trustResolved,
      projectTrustApprovalId,
    });
    return assessPipelineDryRun(expanded as Parameters<typeof assessPipelineDryRun>[0]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      version: '1.0',
      pipeline_id: inputPath,
      verdict: 'blocked',
      side_effects: 'none',
      checks: [
        {
          id: 'contract-validation',
          status: 'blocked',
          message,
        },
      ],
      next_actions: message.includes('[TRUST_REQUIRED]')
        ? [
            `Request and approve project trust, then rerun with --project-trust-approval: pnpm kyberion project-trust request ${inputPath}`,
          ]
        : ['Fix the pipeline ADF/guardrail validation errors and rerun the dry-run.'],
    };
  }
}

export function formatPipelineDryRunReport(
  report: Awaited<ReturnType<typeof runPipelineDryRun>>
): string[] {
  // Repeated identical pass lines (e.g. 15× "system:log is registered") hide
  // the signal — collapse them to one line per distinct check message while
  // warnings and blocks always stay per-step.
  const counts = new Map<string, number>();
  const lines: string[] = [];
  for (const check of report.checks) {
    if (check.status !== 'pass') {
      lines.push(`- ${check.status}: ${check.message}`);
      continue;
    }
    const key = check.message;
    const seen = counts.get(key) ?? 0;
    counts.set(key, seen + 1);
    if (seen === 0) lines.push(`- ${check.status}: ${check.message}`);
  }
  for (const [message, count] of counts) {
    if (count > 1) {
      const index = lines.indexOf(`- pass: ${message}`);
      lines[index] = `- pass: ${message} (×${count})`;
    }
  }
  return [
    `[pipeline-dry-run] ${report.verdict}: ${report.pipeline_id}`,
    ...lines,
    ...report.next_actions.map((action) => `next: ${action}`),
  ];
}

export async function main(
  args = currentProcessArgv()
): Promise<Awaited<ReturnType<typeof runPipelineDryRun>>> {
  const argv = await createStandardYargs(args)
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('json', { type: 'boolean', default: false })
    .option('project-trust-approval', {
      type: 'string',
      describe: 'Approved project-trust request id for this exact pipeline resource',
    })
    .parseSync();
  const report = await runPipelineDryRun(String(argv.input), {
    projectTrustApprovalId: argv['project-trust-approval']
      ? String(argv['project-trust-approval'])
      : undefined,
  });
  return report;
}

export const runPipelineDryRunScript = defineScript({
  name: 'pipeline:dry-run',
  flags: ['json'],
  async run(context) {
    const report = await main(['node', 'run_pipeline_dry_run.ts', ...context.argv]);
    context.print(context.json ? report : formatPipelineDryRunReport(report).join('\n'));
    if (report.verdict === 'blocked') {
      throw new ScriptExitError(1, report.checks.map((check) => check.message).join('\n'));
    }
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'run_pipeline_dry_run.ts') ||
  isDirectScript(import.meta.url, 'run_pipeline_dry_run.js')
)
  void runPipelineDryRunScript();
