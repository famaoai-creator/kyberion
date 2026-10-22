import {
  acceptPromotedPipelineBinding,
  requestPipelineBindingApproval,
} from '@agent/core/accepted-pipeline-bindings';
import { createStandardYargs } from '@agent/core/cli-utils';
import { defineScript, isDirectScript } from './lib/harness.js';

export async function acceptPipelineFromArgs(args: string[]) {
  const argv = await createStandardYargs(['node', 'pipeline_accept', ...args])
    .option('pipeline', {
      type: 'string',
      demandOption: true,
      description: 'Promoted root pipeline path',
    })
    .option('intent', {
      type: 'string',
      demandOption: true,
      description: 'Governed intent ID',
    })
    .option('run-id', {
      type: 'string',
      demandOption: true,
      description: 'Canonical successful pipeline run ID',
    })
    .option('request-approval', {
      type: 'boolean',
      default: false,
      description: 'Create the governed human approval request instead of accepting',
    })
    .option('approval-id', {
      type: 'string',
      description: 'Approved governed request ID for the exact binding effect',
    })
    .option('approval-storage-channel', { type: 'string', default: 'pipeline-binding' })
    .option('tier', {
      type: 'string',
      choices: ['public', 'confidential', 'personal'],
      demandOption: true,
    })
    .option('tenant', { type: 'string' })
    .option('organization', { type: 'string' })
    .option('project', { type: 'string' })
    .strict()
    .parseSync();

  const input = {
    pipeline_ref: argv.pipeline,
    intent_id: argv.intent,
    successful_run_id: argv.runId,
    scope: {
      tier: argv.tier as 'public' | 'confidential' | 'personal',
      ...(argv.tenant ? { tenant_slug: argv.tenant } : {}),
      ...(argv.organization ? { organization_id: argv.organization } : {}),
      ...(argv.project ? { project_id: argv.project } : {}),
    },
  };
  if (argv.requestApproval) return requestPipelineBindingApproval(input);
  if (!argv.approvalId) {
    throw new Error('Acceptance requires --approval-id from a prior --request-approval flow');
  }
  return acceptPromotedPipelineBinding({
    ...input,
    approval_request_id: argv.approvalId,
    approval_storage_channel: argv.approvalStorageChannel,
  });
}

export const runPipelineAcceptance = defineScript({
  name: 'pipeline:accept',
  flags: ['json'],
  run: async ({ argv, print }) => {
    const binding = await acceptPipelineFromArgs(argv);
    print(binding);
    return binding;
  },
});

if (
  isDirectScript(import.meta.url, 'pipeline_accept.ts') ||
  isDirectScript(import.meta.url, 'pipeline_accept.js')
) {
  void runPipelineAcceptance();
}
