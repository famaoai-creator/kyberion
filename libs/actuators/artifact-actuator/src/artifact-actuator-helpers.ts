import {
  appendGovernedArtifactJsonl,
  ensureGovernedArtifactDir,
  listGovernedArtifacts,
  readGovernedArtifactJson,
  resolveGovernedArtifactPath,
  writeGovernedArtifactJson,
  buildGovernedRetryOptions,
  classifyError,
  retry,
  type GovernedArtifactRole,
} from '@agent/core';
import { pathResolver } from '@agent/core';
import { safeReadFile } from '@agent/core';

export interface ArtifactAction {
  action:
    | 'write_json'
    | 'append_event'
    | 'read_json'
    | 'list'
    | 'ensure_dir'
    | 'write_delivery_pack';
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

const ARTIFACT_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/artifact-actuator/manifest.json'
);
const DEFAULT_ARTIFACT_RETRY = {
  maxRetries: 2,
  initialDelayMs: 250,
  maxDelayMs: 2000,
  factor: 2,
  jitter: true,
};

function buildRetryOptions(override?: Record<string, any>) {
  return buildGovernedRetryOptions({
    manifestPath: ARTIFACT_MANIFEST_PATH,
    defaults: DEFAULT_ARTIFACT_RETRY,
    override: override,
    fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
  });
}

export async function handleArtifactAction(input: ArtifactAction) {
  const params = input.params || ({} as any);
  const role = params.role || 'mission_controller';
  switch (input.action) {
    case 'write_json':
      if (!params.logicalPath) throw new Error('logicalPath is required');
      return await retry(
        async () => ({
          status: 'written',
          path: writeGovernedArtifactJson(role, params.logicalPath, params.value ?? {}),
        }),
        buildRetryOptions()
      );
    case 'append_event':
      if (!params.logicalPath) throw new Error('logicalPath is required');
      return await retry(
        async () => ({
          status: 'appended',
          path: appendGovernedArtifactJsonl(role, params.logicalPath, params.value ?? {}),
        }),
        buildRetryOptions()
      );
    case 'read_json':
      if (!params.logicalPath) throw new Error('logicalPath is required');
      return await retry(
        async () => ({
          status: 'ok',
          path: resolveGovernedArtifactPath(params.logicalPath),
          value: readGovernedArtifactJson(params.logicalPath),
        }),
        buildRetryOptions()
      );
    case 'list':
      if (!params.logicalDir) throw new Error('logicalDir is required');
      return await retry(
        async () => ({
          status: 'ok',
          entries: listGovernedArtifacts(params.logicalDir),
        }),
        buildRetryOptions()
      );
    case 'ensure_dir':
      if (!params.logicalDir) throw new Error('logicalDir is required');
      return await retry(
        async () => ({
          status: 'ensured',
          path: ensureGovernedArtifactDir(role, params.logicalDir),
        }),
        buildRetryOptions()
      );
    case 'write_delivery_pack': {
      if (!params.logicalDir) throw new Error('logicalDir is required');
      return await retry(async () => {
        const dir = ensureGovernedArtifactDir(role, params.logicalDir);
        const packId = params.packId || `delivery-pack-${Date.now()}`;
        const logicalPath = pathResolver.rootResolve(`${params.logicalDir}/${packId}.json`);
        const payload = {
          kind: 'delivery-pack',
          pack_id: packId,
          summary: params.summary || 'Governed delivery pack',
          main_artifact_id: params.mainArtifactId || '',
          request_text: params.requestText || '',
          conversation_summary: params.conversationSummary || '',
          recommended_next_action: params.recommendedNextAction || '',
          artifacts_by_role: params.artifactsByRole || {},
          artifacts: Array.isArray(params.artifacts) ? params.artifacts : [],
        };
        return {
          status: 'written',
          dir,
          path: writeGovernedArtifactJson(role, logicalPath, payload),
          value: payload,
        };
      }, buildRetryOptions());
    }
    default:
      throw new Error(`Unsupported artifact action: ${input.action}`);
  }
}
