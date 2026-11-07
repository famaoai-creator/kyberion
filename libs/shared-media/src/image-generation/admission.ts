import { createHash } from 'node:crypto';
import { safeReadFile } from '@agent/core/secure-io';
import {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationProvider,
} from '../image-generation-types.js';
import {
  assertReferenceEgressAllowed,
  imageProviderDataEgress,
  resolveReferenceImagePath,
} from '../image-reference-consent.js';
import { isHostImageHandoffOutput } from '../host-image-handoff.js';
import { runExternalOperation } from '@agent/core/governance/external-operation';
import { wrapAdapterEffects } from '@agent/core/governance/adapter-effect-proxy';

const admittedImageMethods = new WeakSet<object>();

export const imageReferenceSnapshots = new WeakMap<ImageGenerationRequest, Map<string, Buffer>>();

export function imageNeedsAdmission(provider: ImageGenerationProvider): boolean {
  return (
    imageProviderDataEgress(provider) !== 'local' ||
    provider.costTier === 'paid' ||
    provider.id === 'comfyui'
  );
}

/** Registered/custom providers and direct native cloud instances use the same
 * final generation boundary. Local rendering remains automatic. */
export function governImageProvider<T extends ImageGenerationProvider>(provider: T): T {
  const original = provider.generate;
  if (admittedImageMethods.has(original)) return provider;
  const generate = async (request: ImageGenerationRequest): Promise<ImageGenerationResult> => {
    const snapshot = structuredClone(request);
    assertReferenceEgressAllowed(snapshot, provider);
    const references = new Map(
      (snapshot.referenceImages || []).map((reference) => {
        const referencePath = resolveReferenceImagePath(reference);
        return [
          referencePath,
          Buffer.from(safeReadFile(referencePath, { encoding: null }) as Buffer),
        ] as const;
      })
    );
    const referenceContent = [...references].map(([referencePath, bytes]) => ({
      path: referencePath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    }));
    imageReferenceSnapshots.set(snapshot, references);
    return runExternalOperation(
      {
        operationId: `media:image:${provider.id}:generate`,
        effect: { provider: provider.id, params: snapshot, reference_content: referenceContent },
        requiresApproval:
          imageNeedsAdmission(provider) &&
          !(
            provider.requiresInteractiveHandoff &&
            snapshot.targetPath &&
            isHostImageHandoffOutput(snapshot.targetPath, snapshot.prompt)
          ),
        delegable: false,
      },
      () => {
        for (const reference of referenceContent) {
          const current = safeReadFile(reference.path, { encoding: null }) as Buffer;
          if (createHash('sha256').update(current).digest('hex') !== reference.sha256) {
            throw new Error(
              '[IMAGE_REFERENCE_CHANGED] Revalidate reference content before sending'
            );
          }
        }
        // Native inline upload reads the captured buffers below, not mutable
        // files. Custom adapters are trusted code and revalidate at this call.
        return original.call(provider, snapshot);
      },
      (result) =>
        (result.status === 'succeeded' && typeof result.path === 'string') ||
        (result.status === 'submitted' && typeof result.promptId === 'string')
          ? 'succeeded'
          : 'unknown'
    );
  };
  admittedImageMethods.add(generate);
  return wrapAdapterEffects(provider, (property) =>
    property === 'generate' ? generate : undefined
  );
}
