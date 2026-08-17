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
  ensureDefaultOpPreflight,
  runOpPreflight,
  type GovernedArtifactRole,
} from '@agent/core';
import { pathResolver } from '@agent/core';
import { safeReadFile } from '@agent/core';

export interface ArtifactAction {
  action:
    'write_json' | 'append_event' | 'read_json' | 'list' | 'ensure_dir' | 'write_delivery_pack';
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
  const params = input.params || ({} as ArtifactAction['params']);
  ensureDefaultOpPreflight();
  const preflight = await runOpPreflight({
    op: `artifact:${input.action}`,
    params: params as Record<string, unknown>,
    source: 'actuator',
  });
  if (preflight.decision !== 'allow') {
    throw new Error(
      `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation artifact:${input.action} was not admitted.`}`
    );
  }
  const admittedParams = preflight.input as ArtifactAction['params'];
  const role = params.role || 'mission_controller';
  switch (input.action) {
    case 'write_json':
      if (!admittedParams.logicalPath) throw new Error('logicalPath is required');
      return await retry(
        async () => ({
          status: 'written',
          path: writeGovernedArtifactJson(
            admittedParams.role || role,
            admittedParams.logicalPath,
            admittedParams.value ?? {}
          ),
        }),
        buildRetryOptions()
      );
    case 'append_event':
      if (!admittedParams.logicalPath) throw new Error('logicalPath is required');
      return await retry(
        async () => ({
          status: 'appended',
          path: appendGovernedArtifactJsonl(
            admittedParams.role || role,
            admittedParams.logicalPath,
            admittedParams.value ?? {}
          ),
        }),
        buildRetryOptions()
      );
    case 'read_json':
      if (!admittedParams.logicalPath) throw new Error('logicalPath is required');
      return await retry(
        async () => ({
          status: 'ok',
          path: resolveGovernedArtifactPath(admittedParams.logicalPath),
          value: readGovernedArtifactJson(admittedParams.logicalPath),
        }),
        buildRetryOptions()
      );
    case 'list':
      if (!admittedParams.logicalDir) throw new Error('logicalDir is required');
      return await retry(
        async () => ({
          status: 'ok',
          entries: listGovernedArtifacts(admittedParams.logicalDir),
        }),
        buildRetryOptions()
      );
    case 'ensure_dir':
      if (!admittedParams.logicalDir) throw new Error('logicalDir is required');
      return await retry(
        async () => ({
          status: 'ensured',
          path: ensureGovernedArtifactDir(admittedParams.role || role, admittedParams.logicalDir),
        }),
        buildRetryOptions()
      );
    case 'write_delivery_pack': {
      if (!admittedParams.logicalDir) throw new Error('logicalDir is required');
      return await retry(async () => {
        const dir = ensureGovernedArtifactDir(
          admittedParams.role || role,
          admittedParams.logicalDir
        );
        const packId = admittedParams.packId || `delivery-pack-${Date.now()}`;
        const logicalPath = pathResolver.rootResolve(`${admittedParams.logicalDir}/${packId}.json`);
        const payload = {
          kind: 'delivery-pack',
          pack_id: packId,
          summary: admittedParams.summary || 'Governed delivery pack',
          main_artifact_id: admittedParams.mainArtifactId || '',
          request_text: admittedParams.requestText || '',
          conversation_summary: admittedParams.conversationSummary || '',
          recommended_next_action: admittedParams.recommendedNextAction || '',
          artifacts_by_role: admittedParams.artifactsByRole || {},
          artifacts: Array.isArray(admittedParams.artifacts) ? admittedParams.artifacts : [],
        };
        return {
          status: 'written',
          dir,
          path: writeGovernedArtifactJson(admittedParams.role || role, logicalPath, payload),
          value: payload,
        };
      }, buildRetryOptions());
    }
    default:
      throw new Error(`Unsupported artifact action: ${input.action}`);
  }
}
