import { logger, safeReadFile, safeWriteFile, safeExec } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import yaml from 'js-yaml';

/**
 * Orchestrator-Actuator v1.1.0 [SECURE-IO ENFORCED]
 * Strictly compliant with Layer 2 (Shield).
 */

interface OrchestratorAction {
  action: 'execute' | 'heal' | 'checkpoint' | 'verify_alignment';
  pipeline_path?: string;
  mission_id?: string;
}

async function handleAction(input: OrchestratorAction) {
  const missionId = input.mission_id || `MSN-${Date.now()}`;

  switch (input.action) {
    case 'execute':
      if (!input.pipeline_path) throw new Error('pipeline_path required');
      const pipelineContent = safeReadFile(input.pipeline_path, { encoding: 'utf8' }) as string;
      const pipeline = yaml.load(pipelineContent);
      return { status: 'executing', missionId, steps: (pipeline as any).steps?.length };

    case 'checkpoint':
      safeExec('git', ['add', '.']);
      safeExec('git', ['commit', '-m', `checkpoint(${missionId}): Secure State Preservation`]);
      return { status: 'checkpoint_created' };

    default:
      return { status: 'idle' };
  }
}

const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputContent = safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
