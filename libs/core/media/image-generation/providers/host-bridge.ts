import * as path from 'node:path';
import { logger } from '../../../core.js';
import { getRegisteredEnvText } from '../../../foundation/env.js';
import { nowIso } from '../../../foundation/time.js';
import { pathResolver } from '../../../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '../../../secure-io.js';
import {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationProvider,
  ImageReference,
} from '../../image-generation-types.js';
import {
  assertReferenceEgressAllowed,
  hasReferenceImages,
  imageProviderDataEgress,
  recordReferenceEgressReceipt,
  referenceImageViolation,
  resolveReferenceImagePath,
} from '../../image-reference-consent.js';
import {
  isHostImageHandoffOutput,
  recordHostImageHandoffRequest,
} from '../../../host-image-handoff.js';
import { isInsideProviderHarness } from '../../../agent-execution-context.js';
import { getFallbackTargetPath } from '../provider-support.js';

type HostBridgeVariant =
  'host_agent' | 'codex_host_bridge' | 'agy_host_bridge' | 'cursor_host_bridge';

interface HostBridgeProviderConfig {
  id: HostBridgeVariant;
  displayName: string;
  requestFileName: string;
  errorCode: string;
  availability: () => boolean;
}

/** Repo-relative reference entries for a host hand-off (paths only, never bytes). */
export function hostBridgeReferenceEntries(
  request: ImageGenerationRequest
): Array<{ path: string; mimeType: string; role: string }> {
  return (request.referenceImages ?? []).map((reference) => ({
    path: pathResolver.toRepoRelative(resolveReferenceImagePath(reference)),
    mimeType: reference.mimeType,
    role: reference.role ?? 'subject',
  }));
}

function hostBridgeReferenceInstruction(request: ImageGenerationRequest): string {
  const entries = hostBridgeReferenceEntries(request);
  if (entries.length === 0) return '';
  return ` Use these reference image(s) as input images (do not copy them elsewhere): ${entries
    .map((entry) => `"${entry.path}" (${entry.role})`)
    .join(', ')}.`;
}

function writeHostBridgeRequest(
  config: HostBridgeProviderConfig,
  request: ImageGenerationRequest,
  targetPath: string
): void {
  const requestFilePath = assertSafeRepositoryPath(
    pathResolver.resolve(`active/shared/tmp/${config.requestFileName}`),
    { allowMissingLeaf: true }
  );
  const outputDir = path.dirname(requestFilePath);
  if (!safeExistsSync(outputDir)) {
    safeMkdir(outputDir, { recursive: true });
  }

  try {
    safeWriteFile(
      requestFilePath,
      JSON.stringify(
        {
          bridge_provider: config.id,
          bridge_name: config.displayName,
          prompt: request.prompt,
          targetPath,
          aspectRatio: request.aspectRatio || '1:1',
          ...(hasReferenceImages(request)
            ? {
                referenceImages: hostBridgeReferenceEntries(request),
                egressConsent: request.egressConsent
                  ? {
                      provider_id: request.egressConsent.provider_id,
                      granted_at: request.egressConsent.granted_at,
                    }
                  : null,
              }
            : {}),
          timestamp: nowIso(),
        },
        null,
        2
      )
    );
  } catch {
    // Request metadata is best-effort; the bridge still returns the actionable instruction.
  }
}

abstract class BaseHostBridgeImageGenerationProvider implements ImageGenerationProvider {
  abstract readonly id: HostBridgeVariant;
  readonly costTier = 'environment';
  readonly dataPolicy = 'zero_retention';
  readonly executionLocality = 'local';
  readonly requiresInteractiveHandoff = true;
  /** The host agent forwards the request (and any reference photo) to its own model. */
  readonly dataEgress = 'cloud';
  readonly supportsReferenceImages = true;
  protected abstract readonly config: HostBridgeProviderConfig;

  get displayName(): string {
    return this.config.displayName;
  }

  async isAvailable(): Promise<boolean> {
    return this.config.availability();
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const startedAt = Date.now();
    const targetPath = getFallbackTargetPath(request);

    // Only an image the host saved for this request (same prompt, changed
    // since the request) is collected; a file that was merely there is not.
    if (isHostImageHandoffOutput(targetPath, request.prompt)) {
      logger.info(
        `[image_generation_bridge] ${this.config.displayName} image collected from ${targetPath}.`
      );
      // The host agent has read the references and produced this frame: the
      // second receipt closes the hand-off in the audit chain.
      recordReferenceEgressReceipt(request, this, 'allowed', undefined, 'host_output_collected');
      return {
        status: 'succeeded',
        provider: this.id,
        path: targetPath,
        elapsedMs: Date.now() - startedAt,
      };
    }

    if (safeExistsSync(targetPath)) {
      logger.info(
        `[image_generation_bridge] ${targetPath} exists but was not produced for a hand-off request with this prompt; requesting a new image.`
      );
    }
    assertReferenceEgressAllowed(request, this);
    writeHostBridgeRequest(this.config, request, targetPath);
    recordHostImageHandoffRequest({ providerId: this.id, targetPath, prompt: request.prompt });

    const errMessage = `${this.config.errorCode}: ${this.config.displayName} is required. Please use your 'generate_image' tool with prompt: "${request.prompt}" and save the image to "${targetPath}".${hostBridgeReferenceInstruction(request)} After saving, please rerun the task.`;
    logger.warn(`[image_generation_bridge] ${errMessage}`);
    throw new Error(errMessage);
  }
}

function envFlagEnabled(name: string): boolean {
  return getRegisteredEnvText(name) === 'true';
}

function envAnyEnabled(names: string[]): boolean {
  return names.some((name) => Boolean(getRegisteredEnvText(name)));
}

export class HostAgentImageGenerationProvider extends BaseHostBridgeImageGenerationProvider {
  readonly id = 'host_agent';
  readonly backendIds = ['media-generation.host_agent'];

  protected readonly config: HostBridgeProviderConfig = {
    id: 'host_agent',
    displayName: 'Host agent bridge',
    requestFileName: 'host_agent_image_request.json',
    errorCode: 'HOST_AGENT_IMAGE_GENERATION_REQUIRED',
    availability: () => envFlagEnabled('KYBERION_HOST_AGENT_ACTIVE'),
  };
}

export class CodexHostBridgeImageGenerationProvider extends BaseHostBridgeImageGenerationProvider {
  readonly id = 'codex_host_bridge';

  protected readonly config: HostBridgeProviderConfig = {
    id: 'codex_host_bridge',
    displayName: 'Codex host bridge',
    requestFileName: 'codex_host_bridge_image_request.json',
    errorCode: 'HOST_BRIDGE_IMAGE_GENERATION_REQUIRED',
    availability: () => isInsideProviderHarness('codex-cli'),
  };
}

export class AgyHostBridgeImageGenerationProvider extends BaseHostBridgeImageGenerationProvider {
  readonly id = 'agy_host_bridge';

  protected readonly config: HostBridgeProviderConfig = {
    id: 'agy_host_bridge',
    displayName: 'AGY host bridge',
    requestFileName: 'agy_host_bridge_image_request.json',
    errorCode: 'HOST_BRIDGE_IMAGE_GENERATION_REQUIRED',
    availability: () => isInsideProviderHarness('agy-cli'),
  };
}

export class CursorHostBridgeImageGenerationProvider extends BaseHostBridgeImageGenerationProvider {
  readonly id = 'cursor_host_bridge';
  readonly backendIds = ['media-generation.cursor_host_bridge'];

  protected readonly config: HostBridgeProviderConfig = {
    id: 'cursor_host_bridge',
    displayName: 'Cursor host bridge',
    requestFileName: 'cursor_host_bridge_image_request.json',
    errorCode: 'HOST_BRIDGE_IMAGE_GENERATION_REQUIRED',
    availability: () =>
      isInsideProviderHarness('cursor-cli') ||
      envAnyEnabled(['CURSOR_CLI', 'KYBERION_CURSOR_CLI_BIN', 'CURSOR_API_KEY']),
  };
}
