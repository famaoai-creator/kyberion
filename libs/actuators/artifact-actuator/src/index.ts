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
import { fileURLToPath } from 'node:url';
import { pathResolver } from '@agent/core';

interface ArtifactAction {
  action: 'write_json' | 'append_event' | 'read_json' | 'list' | 'ensure_dir' | 'write_delivery_pack';
  params: {
    role?: GovernedArtifactRole;
    logicalPath?: string;
    logicalDir?: string;
    value?: unknown;
    packId?: string;
    summary?: string;
    requestText?: string;
    mainArtifactId?: string;
    conversationSummary?: string;
    recommendedNextAction?: string;
    artifactsByRole?: {
      primary?: string[];
      specification?: string[];
      evidence?: string[];
    };
    artifacts?: Array<{
      id: string;
      kind: string;
      path: string;
      description?: string;
    }>;
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
    case 'write_delivery_pack': {
      if (!input.params.logicalDir) throw new Error('logicalDir is required');
      const dir = ensureGovernedArtifactDir(role, input.params.logicalDir);
      const packId = input.params.packId || `delivery-pack-${Date.now()}`;
      const logicalPath = path.join(input.params.logicalDir, `${packId}.json`);
      const payload = {
        kind: 'delivery-pack',
        pack_id: packId,
        summary: input.params.summary || 'Governed delivery pack',
        main_artifact_id: input.params.mainArtifactId || '',
        request_text: input.params.requestText || '',
        conversation_summary: input.params.conversationSummary || '',
        recommended_next_action: input.params.recommendedNextAction || '',
        artifacts_by_role: input.params.artifactsByRole || {},
        artifacts: Array.isArray(input.params.artifacts) ? input.params.artifacts : [],
      };
      return {
        status: 'written',
        dir,
        path: writeGovernedArtifactJson(role, logicalPath, payload),
        value: payload,
      };
    }
    default:
      throw new Error(`Unsupported artifact action: ${input.action}`);
  }
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();
  const inputPath = pathResolver.rootResolve(argv.input as string);
  const input = JSON.parse(safeReadFile(inputPath, { encoding: 'utf8' }) as string) as ArtifactAction;
  const result = await handleAction(input);
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err: any) => {
    logger.error(err.message);
    process.exit(1);
  });
}
