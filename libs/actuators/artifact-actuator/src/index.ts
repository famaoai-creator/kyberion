import {
  appendGovernedArtifactJsonl,
  createStandardYargs,
  ensureGovernedArtifactDir,
  listGovernedArtifacts,
  logger,
  readGovernedArtifactJson,
  resolveGovernedArtifactPath,
  safeReadFile,
  writeGovernedArtifactJson,
  type GovernedArtifactRole,
} from '@agent/core';
import * as path from 'node:path';

interface ArtifactAction {
  action: 'write_json' | 'append_event' | 'read_json' | 'list' | 'ensure_dir';
  params: {
    role?: GovernedArtifactRole;
    logicalPath?: string;
    logicalDir?: string;
    value?: unknown;
  };
}

export async function handleAction(input: ArtifactAction) {
  const role = input.params.role || 'mission_controller';
  switch (input.action) {
    case 'write_json':
      if (!input.params.logicalPath) throw new Error('logicalPath is required');
      return {
        status: 'written',
        path: writeGovernedArtifactJson(role, input.params.logicalPath, input.params.value ?? {}),
      };
    case 'append_event':
      if (!input.params.logicalPath) throw new Error('logicalPath is required');
      return {
        status: 'appended',
        path: appendGovernedArtifactJsonl(role, input.params.logicalPath, input.params.value ?? {}),
      };
    case 'read_json':
      if (!input.params.logicalPath) throw new Error('logicalPath is required');
      return {
        status: 'ok',
        path: resolveGovernedArtifactPath(input.params.logicalPath),
        value: readGovernedArtifactJson(input.params.logicalPath),
      };
    case 'list':
      if (!input.params.logicalDir) throw new Error('logicalDir is required');
      return {
        status: 'ok',
        entries: listGovernedArtifacts(input.params.logicalDir),
      };
    case 'ensure_dir':
      if (!input.params.logicalDir) throw new Error('logicalDir is required');
      return {
        status: 'ensured',
        path: ensureGovernedArtifactDir(role, input.params.logicalDir),
      };
    default:
      throw new Error(`Unsupported artifact action: ${input.action}`);
  }
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();
  const inputPath = path.resolve(process.cwd(), argv.input as string);
  const input = JSON.parse(safeReadFile(inputPath, { encoding: 'utf8' }) as string) as ArtifactAction;
  const result = await handleAction(input);
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch((err: any) => {
    logger.error(err.message);
    process.exit(1);
  });
}
