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
  classifyError,
  withRetry,
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

const ARTIFACT_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/artifact-actuator/manifest.json');
const DEFAULT_ARTIFACT_RETRY = {
  maxRetries: 2,
  initialDelayMs: 250,
  maxDelayMs: 2000,
  factor: 2,
  jitter: true,
};

let cachedRecoveryPolicy: Record<string, any> | null = null;

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(safeReadFile(ARTIFACT_MANIFEST_PATH, { encoding: 'utf8' }) as string);
    cachedRecoveryPolicy = isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
    return cachedRecoveryPolicy;
  } catch (_) {
    cachedRecoveryPolicy = {};
    return cachedRecoveryPolicy;
  }
}

function buildRetryOptions(override?: Record<string, any>) {
  const recoveryPolicy = loadRecoveryPolicy();
  const manifestRetry = isPlainObject(recoveryPolicy.retry) ? recoveryPolicy.retry : {};
  const retryableCategories = new Set<string>(
    Array.isArray(recoveryPolicy.retryable_categories) ? recoveryPolicy.retryable_categories.map(String) : [],
  );
  const resolved = {
    ...DEFAULT_ARTIFACT_RETRY,
    ...manifestRetry,
    ...(override || {}),
  };
  return {
    ...resolved,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      if (retryableCategories.size > 0) {
        return retryableCategories.has(classification.category);
      }
      return classification.category === 'network'
        || classification.category === 'rate_limit'
        || classification.category === 'timeout'
        || classification.category === 'resource_unavailable';
    },
  };
}

export async function handleAction(input: ArtifactAction) {
  const role = input.params.role || 'mission_controller';
  switch (input.action) {
    case 'write_json':
      if (!input.params.logicalPath) throw new Error('logicalPath is required');
      return await withRetry(async () => ({
        status: 'written',
        path: writeGovernedArtifactJson(role, input.params.logicalPath, input.params.value ?? {}),
      }), buildRetryOptions());
    case 'append_event':
      if (!input.params.logicalPath) throw new Error('logicalPath is required');
      return await withRetry(async () => ({
        status: 'appended',
        path: appendGovernedArtifactJsonl(role, input.params.logicalPath, input.params.value ?? {}),
      }), buildRetryOptions());
    case 'read_json':
      if (!input.params.logicalPath) throw new Error('logicalPath is required');
      return await withRetry(async () => ({
        status: 'ok',
        path: resolveGovernedArtifactPath(input.params.logicalPath),
        value: readGovernedArtifactJson(input.params.logicalPath),
      }), buildRetryOptions());
    case 'list':
      if (!input.params.logicalDir) throw new Error('logicalDir is required');
      return await withRetry(async () => ({
        status: 'ok',
        entries: listGovernedArtifacts(input.params.logicalDir),
      }), buildRetryOptions());
    case 'ensure_dir':
      if (!input.params.logicalDir) throw new Error('logicalDir is required');
      return await withRetry(async () => ({
        status: 'ensured',
        path: ensureGovernedArtifactDir(role, input.params.logicalDir),
      }), buildRetryOptions());
    case 'write_delivery_pack': {
      if (!input.params.logicalDir) throw new Error('logicalDir is required');
      return await withRetry(async () => {
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
      }, buildRetryOptions());
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
