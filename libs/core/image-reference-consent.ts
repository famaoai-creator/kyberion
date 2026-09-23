/**
 * PA-10: reference-image egress governance for image generation.
 *
 * A request that carries `referenceImages` (e.g. the user's own photo, read
 * from the personal/profile tier) may only reach a provider that
 *   1. can honour references (`supportsReferenceImages`), and
 *   2. keeps the data on this machine (`dataEgress: 'local'`), or — for a
 *      cloud provider — carries an explicit per-run `ImageEgressConsent`
 *      naming exactly that provider.
 *
 * Enforcement lives here (core), is applied by the router when it builds the
 * candidate chain, and again inside every cloud / host-bridge provider's
 * `generate()` so a direct provider call cannot bypass it. Every reference
 * request that is actually dispatched leaves an audit-chain receipt (consent,
 * provider, reference count and roles — never the photo path or bytes).
 *
 * Host-bridge providers (`host_agent`, `codex_host_bridge`, …) never upload
 * anything themselves: they hand the host agent repo-relative reference paths
 * (request JSON / `active/shared/tmp/avatar-set-handoff.json`, never bytes).
 * The egress happens later, when the host agent reads those files and sends
 * them to its own model — which is why the consent is required at hand-off
 * time. The rerun that picks up the host-produced frames records a second
 * receipt (`stage: 'host_output_collected'`) so the audit chain shows both
 * the hand-off and the completed host egress.
 */
import { auditChain } from './audit-chain.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath } from './secure-io.js';
import type {
  ImageDataEgress,
  ImageEgressConsent,
  ImageGenerationProvider,
  ImageGenerationRequest,
  ImageReference,
} from './image-generation-types.js';

/** A consent is for one run: it expires this long after `granted_at`. */
export const IMAGE_EGRESS_CONSENT_MAX_AGE_MS = 60 * 60 * 1000;
/** Clock skew tolerated for a `granted_at` slightly in the future. */
const CONSENT_FUTURE_SKEW_MS = 5 * 60 * 1000;

export const REFERENCE_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export function hasReferenceImages(request: Pick<ImageGenerationRequest, 'referenceImages'>) {
  return Array.isArray(request.referenceImages) && request.referenceImages.length > 0;
}

/** Declared egress, else derived from executionLocality (only `local` is local). */
export function imageProviderDataEgress(
  provider: Pick<ImageGenerationProvider, 'dataEgress' | 'executionLocality'>
): ImageDataEgress {
  if (provider.dataEgress) return provider.dataEgress;
  return provider.executionLocality === 'local' ? 'local' : 'cloud';
}

export interface ImageEgressConsentValidation {
  allowed: boolean;
  reason?: string;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validate a consent for one provider; pure (no I/O). */
export function validateImageEgressConsent(
  consent: unknown,
  providerId: string,
  options: { nowMs?: number; maxAgeMs?: number } = {}
): ImageEgressConsentValidation {
  if (!consent || typeof consent !== 'object' || Array.isArray(consent)) {
    return { allowed: false, reason: 'no user_photo egress consent attached' };
  }
  const record = consent as Record<string, unknown>;
  if (record.subject !== 'user_photo') {
    return { allowed: false, reason: `consent subject must be user_photo` };
  }
  if (record.provider_class !== 'cloud') {
    return { allowed: false, reason: 'consent provider_class must be cloud' };
  }
  if (!nonEmpty(record.provider_id) || record.provider_id !== providerId) {
    return {
      allowed: false,
      reason: `consent names provider '${String(record.provider_id ?? '')}', not '${providerId}'`,
    };
  }
  if (!nonEmpty(record.granted_by)) {
    return { allowed: false, reason: 'consent granted_by is required' };
  }
  const grantedMs = nonEmpty(record.granted_at) ? Date.parse(record.granted_at) : NaN;
  if (!Number.isFinite(grantedMs)) {
    return { allowed: false, reason: 'consent granted_at must be an ISO datetime' };
  }
  const now = options.nowMs ?? Date.now();
  if (grantedMs - now > CONSENT_FUTURE_SKEW_MS) {
    return { allowed: false, reason: 'consent granted_at is in the future' };
  }
  if (now - grantedMs > (options.maxAgeMs ?? IMAGE_EGRESS_CONSENT_MAX_AGE_MS)) {
    return { allowed: false, reason: 'consent has expired (per-run consent)' };
  }
  return { allowed: true };
}

export function createImageEgressConsent(input: {
  providerId: string;
  grantedBy: string;
  grantedAt?: string;
}): ImageEgressConsent {
  if (!nonEmpty(input.providerId)) throw new Error('consent providerId is required');
  if (!nonEmpty(input.grantedBy)) throw new Error('consent grantedBy is required');
  return {
    subject: 'user_photo',
    provider_id: input.providerId.trim(),
    provider_class: 'cloud',
    granted_at: input.grantedAt ?? new Date().toISOString(),
    granted_by: input.grantedBy.trim(),
  };
}

/**
 * Why this provider may not receive this request's reference images, or null.
 * Requests without references are never restricted here.
 */
export function referenceImageViolation(
  request: ImageGenerationRequest,
  provider: ImageGenerationProvider,
  options: { ignoreConsent?: boolean; nowMs?: number } = {}
): string | null {
  if (!hasReferenceImages(request)) return null;
  if (!provider.supportsReferenceImages) {
    return 'provider cannot honour reference images';
  }
  if (imageProviderDataEgress(provider) === 'cloud' && !options.ignoreConsent) {
    const verdict = validateImageEgressConsent(request.egressConsent, provider.id, {
      nowMs: options.nowMs,
    });
    if (!verdict.allowed) {
      return `cloud provider needs explicit user_photo consent: ${verdict.reason}`;
    }
  }
  return null;
}

export class ImageEgressConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageEgressConsentError';
  }
}

/** Throwing form used inside providers (defense in depth against direct calls). */
export function assertReferenceEgressAllowed(
  request: ImageGenerationRequest,
  provider: ImageGenerationProvider
): void {
  const violation = referenceImageViolation(request, provider);
  if (violation) {
    throw new ImageEgressConsentError(
      `[IMAGE_REFERENCE_EGRESS_DENIED] ${provider.id}: ${violation}`
    );
  }
}

/** Resolve and validate a reference inside the repository (no read). */
export function resolveReferenceImagePath(reference: ImageReference): string {
  if (!nonEmpty(reference?.path)) throw new Error('reference image path is required');
  if (!(REFERENCE_IMAGE_MIME_TYPES as readonly string[]).includes(reference.mimeType)) {
    throw new Error(`reference image mimeType not allowed: ${String(reference.mimeType)}`);
  }
  return assertSafeRepositoryPath(pathResolver.resolve(reference.path), {
    allowMissingLeaf: true,
  });
}

/**
 * Audit receipt for a dispatched reference request. Records who consented, to
 * which provider and class, and how many references of which roles — never
 * the reference paths or bytes (they are personal-tier data).
 */
export function recordReferenceEgressReceipt(
  request: ImageGenerationRequest,
  provider: ImageGenerationProvider,
  result: 'allowed' | 'denied',
  reason?: string,
  stage?: 'host_output_collected'
): void {
  if (!hasReferenceImages(request)) return;
  const egress = imageProviderDataEgress(provider);
  const consent = request.egressConsent;
  try {
    auditChain.record({
      agentId: 'image-generation-bridge',
      action: 'image_generation.reference_egress',
      operation: provider.id,
      result,
      ...(reason ? { reason } : {}),
      metadata: {
        provider_id: provider.id,
        data_egress: egress,
        reference_count: request.referenceImages!.length,
        reference_roles: request.referenceImages!.map((ref) => ref.role ?? 'subject'),
        ...(stage ? { stage } : {}),
        ...(egress === 'cloud' && consent
          ? {
              consent_subject: consent.subject,
              consent_provider_id: consent.provider_id,
              consent_provider_class: consent.provider_class,
              consent_granted_at: consent.granted_at,
              consent_granted_by: consent.granted_by,
            }
          : {}),
      },
    });
  } catch (error) {
    // Fail closed: a photo is never sent to a cloud provider without a receipt.
    if (result === 'allowed' && egress === 'cloud') {
      throw new ImageEgressConsentError(
        `[IMAGE_REFERENCE_EGRESS_DENIED] ${provider.id}: audit receipt could not be recorded (${
          error instanceof Error ? error.message : String(error)
        })`
      );
    }
  }
}
